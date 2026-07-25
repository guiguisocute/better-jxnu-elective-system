package app

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	xhtml "golang.org/x/net/html"
)

// 新生嗅探的探路工具。这两个页面的字段名（学院/班级/年级/专业下拉、查询按钮）
// 只能从真实页面上读出来，猜不出来；newstudents.go 里写死的那些常量就是这样来的。
// 教务改版时先跑它，再照着输出改常量。

type FormSelect struct {
	Name     string   `json:"name"`
	ID       string   `json:"id"`
	Selected string   `json:"selected"`
	Options  []string `json:"options"`
}

type FormProbe struct {
	URL      string       `json:"url"`
	Bytes    int          `json:"bytes"`
	LoggedIn bool         `json:"loggedIn"`
	Action   string       `json:"action"`
	Selects  []FormSelect `json:"selects"`
	Inputs   []string     `json:"inputs"`
	Tables   []string     `json:"tables"`
	Excerpt  string       `json:"excerpt"`
}

// ProbeStudentSearch fetches the 学生查询 page and reports its form shape.
// steps drives AutoPostBack controls (the 所在单位 dropdowns only exist after the
// rbtType radio has posted back), each step being the extra form values to send.
func (c *JWCClient) ProbeStudentSearch(ctx context.Context, pageURL string, steps ...map[string]string) (FormProbe, error) {
	if pageURL == "" {
		pageURL = studentSearchURL
	}
	if !c.IsAuthed() {
		if err := c.Login(ctx); err != nil {
			return FormProbe{}, err
		}
	}
	_, body, err := c.do(ctx, http.MethodGet, pageURL, nil, http.Header{"Referer": {jwcBase + "/"}})
	if err != nil {
		return FormProbe{}, err
	}
	for _, step := range steps {
		if body, err = c.postForm(ctx, pageURL, body, step); err != nil {
			return FormProbe{}, err
		}
	}
	probe := FormProbe{URL: pageURL, Bytes: len(body), LoggedIn: !looksLoggedOut(body)}
	doc, err := parseHTML(body)
	if err != nil {
		return probe, err
	}
	if form := findFirst(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "form")
	}); form != nil {
		probe.Action = attr(form, "action")
	}
	for _, node := range findAll(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "select")
	}) {
		item := FormSelect{Name: attr(node, "name"), ID: attr(node, "id")}
		for _, option := range findAll(node, func(n *xhtml.Node) bool {
			return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "option")
		}) {
			item.Options = append(item.Options, attr(option, "value")+" = "+nodeText(option))
			if hasAttr(option, "selected") {
				item.Selected = attr(option, "value")
			}
		}
		probe.Selects = append(probe.Selects, item)
	}
	for _, node := range findAll(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "input")
	}) {
		name, kind, value := attr(node, "name"), attr(node, "type"), attr(node, "value")
		if strings.HasPrefix(name, "__") {
			value = "<len " + strconv.Itoa(len(value)) + ">"
		}
		probe.Inputs = append(probe.Inputs, kind+" "+name+" = "+value)
	}
	// 结果表没有 id，所以不能按 id 找；这里把所有表都列出来，并给出前几行内容，
	// 由人判断哪张是名单表。
	for _, node := range findAll(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "table")
	}) {
		rows := parseTableRows(node)
		if len(rows) == 0 {
			continue
		}
		line := "id=" + attr(node, "id") + " class=" + attr(node, "class") + " rows=" + strconv.Itoa(len(rows))
		for i, row := range rows {
			if i >= 3 {
				break
			}
			var cells []string
			for _, cell := range row {
				cells = append(cells, cell.Text)
			}
			line += " | [" + strings.Join(cells, " ; ") + "]"
		}
		probe.Tables = append(probe.Tables, truncateRunes(line, 400))
	}
	probe.Excerpt = truncateRunes(cleanText(nodeText(doc)), 600)
	return probe, nil
}
