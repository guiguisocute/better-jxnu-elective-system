package app

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	xhtml "golang.org/x/net/html"
)

// 新生嗅探的两个采集面。都是有状态的 ASP.NET 表单：下拉框的可选值由上一次响应的
// __EVENTVALIDATION 决定，所以每一级选择都必须真的 POST 一次，值也必须原样回填
// （教务把它们右填充成定宽字符串，"080901  " 少一个空格就换来一个「系统错误」页）。
// 字段名是 newstudents_probe.go 从真实页面读出来的，不是猜的。
const (
	studentSearchURL = jwcBase + "/User/default.aspx?&&code=119&uctl=MyControl%5call_searchstudent.ascx"
	trainingPlanURL  = jwcBase + "/User/default.aspx?&code=104&&uctl=MyControl%5call_jxjh.ascx"

	// 名单表列名。学号是唯一要留下的字段——姓名/性别一律不读、不存，与
	// student_records 的去标识化口径保持一致。
	rosterTableID  = "_ctl1_dgContent"
	rosterIDHeader = "学号"
)

type selectOption struct{ Value, Label string }

// FreshmanClass identifies one class in one college; Value must be sent back
// byte-for-byte, padding included.
type FreshmanClass struct {
	CollegeValue string `json:"collegeValue"`
	CollegeName  string `json:"collegeName"`
	ClassValue   string `json:"classValue"`
	ClassName    string `json:"className"`
}

// FreshmanRoster is one class's de-identified roster.
type FreshmanRoster struct {
	FreshmanClass
	StudentIDs []string `json:"studentIds"`
}

// PlanProbe summarises one (年级×专业) training plan without keeping its body.
type PlanProbe struct {
	MajorValue string `json:"majorValue"`
	MajorName  string `json:"majorName"`
	Courses    int    `json:"courses"`
	Natures    int    `json:"natures"`
	HasGoal    bool   `json:"hasGoal"`
}

func selectOptions(doc *xhtml.Node, name string) []selectOption {
	node := findFirst(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "select") && attr(n, "name") == name
	})
	if node == nil {
		return nil
	}
	var out []selectOption
	for _, option := range findAll(node, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "option")
	}) {
		if value := attr(option, "value"); value != "" {
			out = append(out, selectOption{value, cleanText(nodeText(option))})
		}
	}
	return out
}

// gradePrefix turns a 4-digit enrolment year into the class-label prefix the
// 教务 uses ("2026" → "26级").
func gradePrefix(grade string) string {
	if len(grade) != 4 {
		return ""
	}
	return grade[2:] + "级"
}

// ---------------------------------------------------------------- 学号名单

// OpenCollegeMode switches the 学生信息 page into 所在单位 mode and returns both
// the resulting page and its college list. The 所在单位 dropdowns simply do not
// exist until the rbtType radio has posted back.
func (c *JWCClient) OpenCollegeMode(ctx context.Context) (string, []selectOption, error) {
	_, body, err := c.do(ctx, http.MethodGet, studentSearchURL, nil, http.Header{"Referer": {jwcBase + "/"}})
	if err != nil {
		return "", nil, err
	}
	body, err = c.postForm(ctx, studentSearchURL, body, map[string]string{
		"__EVENTTARGET": "_ctl1:rbtType", "_ctl1:rbtType": "College",
	})
	if err != nil {
		return "", nil, err
	}
	doc, err := parseHTML(body)
	if err != nil {
		return "", nil, err
	}
	colleges := selectOptions(doc, "_ctl1:ddlCollege")
	if len(colleges) == 0 {
		return "", nil, fmt.Errorf("学生信息页没有「所在单位」下拉框，页面结构可能已变化")
	}
	return body, colleges, nil
}

// ClassesOf lists one college's classes. It returns the page too, because the
// roster query must be posted from exactly this response (its __EVENTVALIDATION
// is what makes the class value acceptable).
func (c *JWCClient) ClassesOf(ctx context.Context, page string, college selectOption) (string, []FreshmanClass, error) {
	body, err := c.postForm(ctx, studentSearchURL, page, map[string]string{
		"__EVENTTARGET": "_ctl1:ddlCollege", "_ctl1:rbtType": "College", "_ctl1:ddlCollege": college.Value,
	})
	if err != nil {
		return "", nil, err
	}
	doc, err := parseHTML(body)
	if err != nil {
		return "", nil, err
	}
	var classes []FreshmanClass
	for _, option := range selectOptions(doc, "_ctl1:ddlClass") {
		classes = append(classes, FreshmanClass{college.Value, college.Label, option.Value, option.Label})
	}
	return body, classes, nil
}

// RosterOf runs the 查询 for one class and returns its 学号 only.
func (c *JWCClient) RosterOf(ctx context.Context, page string, class FreshmanClass) ([]string, error) {
	body, err := c.postForm(ctx, studentSearchURL, page, map[string]string{
		"_ctl1:rbtType": "College", "_ctl1:ddlCollege": class.CollegeValue,
		"_ctl1:ddlClass": class.ClassValue, "_ctl1:btnSearch": "查询",
	})
	if err != nil {
		return nil, err
	}
	if strings.Contains(body, "系统错误") && len(body) < 200 {
		return nil, fmt.Errorf("教务拒绝了班级 %s 的查询（值可能已变化）", class.ClassName)
	}
	doc, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	// 名单表只有在这个班真有学生时才会渲染出来；查不到人 = 表不存在，不是错误。
	rows := parseTableRows(findTable(doc, rosterTableID))
	if len(rows) < 2 {
		return nil, nil
	}
	column := -1
	for i, cell := range rows[0] {
		if cell.Text == rosterIDHeader {
			column = i
			break
		}
	}
	if column < 0 {
		return nil, fmt.Errorf("名单表没有「%s」列，页面结构可能已变化", rosterIDHeader)
	}
	var ids []string
	for _, row := range rows[1:] {
		if column >= len(row) {
			continue
		}
		if sid := cleanText(row[column].Text); isStudentID(sid) {
			ids = append(ids, sid)
		}
	}
	return ids, nil
}

func isStudentID(value string) bool {
	if len(value) < 6 || len(value) > 20 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------- 培养方案

// PlanMajors lists the 专业 dropdown of the 培养方案 page.
func (c *JWCClient) PlanMajors(ctx context.Context) (string, []selectOption, error) {
	_, body, err := c.do(ctx, http.MethodGet, trainingPlanURL, nil, http.Header{"Referer": {jwcBase + "/"}})
	if err != nil {
		return "", nil, err
	}
	doc, err := parseHTML(body)
	if err != nil {
		return "", nil, err
	}
	majors := selectOptions(doc, "_ctl1:zhuanye")
	if len(majors) == 0 {
		return "", nil, fmt.Errorf("培养方案页没有「专业」下拉框，页面结构可能已变化")
	}
	return body, majors, nil
}

// PlanOf queries one (年级×专业) plan and summarises how complete it looks.
//
// 「有没有」和「全不全」是两回事：2026 级的方案在 2026-07 就能查到，但只有
// 公共必修 + 专业类基础两张表，没有培养目标，也没有专业主干/限选。所以判据是
// 课程数与性质数，不是「查得到就算好了」。
func (c *JWCClient) PlanOf(ctx context.Context, page, grade string, major selectOption) (PlanProbe, error) {
	probe := PlanProbe{MajorValue: major.Value, MajorName: major.Label}
	body, err := c.postForm(ctx, trainingPlanURL, page, map[string]string{
		"_ctl1:Nianji": grade + "/9/1 0:00:00", "_ctl1:zhuanye": major.Value, "_ctl1:GoSearch": "查询",
	})
	if err != nil {
		return probe, err
	}
	if strings.Contains(body, "系统错误") && len(body) < 200 {
		return probe, fmt.Errorf("教务拒绝了 %s 的培养方案查询", major.Label)
	}
	doc, err := parseHTML(body)
	if err != nil {
		return probe, err
	}
	natures := map[string]bool{}
	for _, table := range findAll(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "table")
	}) {
		rows := parseTableRows(table)
		if len(rows) < 2 || len(rows[0]) < 2 || rows[0][0].Text != "课程性质" {
			continue
		}
		for _, row := range rows[1:] {
			if len(row) < 2 {
				continue
			}
			natures[row[0].Text] = true
			probe.Courses++
		}
	}
	probe.Natures = len(natures)
	probe.HasGoal = strings.Contains(body, "培养目标")
	return probe, nil
}

// postForm replays one ASP.NET postback, carrying the previous response's hidden
// state forward.
func (c *JWCClient) postForm(ctx context.Context, pageURL, previous string, values map[string]string) (string, error) {
	doc, err := parseHTML(previous)
	if err != nil {
		return "", err
	}
	form := url.Values{
		"__EVENTTARGET": {""}, "__EVENTARGUMENT": {""}, "__LASTFOCUS": {""},
		"__VIEWSTATE":          {hiddenValue(doc, "__VIEWSTATE")},
		"__VIEWSTATEGENERATOR": {hiddenValue(doc, "__VIEWSTATEGENERATOR")},
		"__EVENTVALIDATION":    {hiddenValue(doc, "__EVENTVALIDATION")},
	}
	for key, value := range values {
		form.Set(key, value)
	}
	_, body, err := c.do(ctx, http.MethodPost, pageURL, form, http.Header{"Referer": {pageURL}})
	if err != nil {
		return "", err
	}
	if looksLoggedOut(body) {
		return "", fmt.Errorf("教务会话已失效")
	}
	return body, nil
}

func plural(n int, unit string) string { return strconv.Itoa(n) + unit }
