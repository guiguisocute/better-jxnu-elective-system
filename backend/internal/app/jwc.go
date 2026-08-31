package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	htmlstd "html"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	xhtml "golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

const (
	casBase    = "https://uis.jxnu.edu.cn/cas"
	jwcBase    = "https://jwc.jxnu.edu.cn"
	authCookie = "SjdJsfJfXfsFsdf"
)

var dayLabels = []string{"星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"}

type SemesterChoice struct {
	Value    string
	Label    string
	Selected bool
}

type DetailCourse struct {
	CourseNo      string
	CourseName    string
	WeeklyHours   string
	TeachingClass string
	Teacher       string
	Semester      string
}

type ScheduleItem struct {
	CourseName    string `json:"courseName"`
	Teacher       string `json:"teacher"`
	Location      string `json:"location"`
	DayOfWeek     int    `json:"dayOfWeek"`
	DayLabel      string `json:"dayLabel"`
	StartPeriod   int    `json:"startPeriod"`
	EndPeriod     int    `json:"endPeriod"`
	TeachingClass string `json:"teachingClass"`
	CourseNo      string `json:"courseNo"`
	WeeklyHours   string `json:"weeklyHours"`
}

type StudentAggregate struct {
	ClassName      string
	Courses        []DetailCourse
	PlanningTerm   string
	ScheduleItems  []ScheduleItem
	NoSchedule     bool
	AvailableTerms []string
}

type JWCClient struct {
	client   *http.Client
	username string
	password string
	service  string
	// termCache, when set, lets FetchStudent skip the ASP.NET postback for any
	// past term it already has. Nil is valid and means "always fetch everything".
	termCache *termCourseCache
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func NewJWCClient(username, password string) *JWCClient {
	jar, _ := cookiejar.New(nil)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// 这个 client 同时承担 CAS 登录：uis 的 /jwt/publicKey 和随后的密码 POST 都走它。
	// 一旦关掉证书校验，中间人可以换掉那把公钥，教务账号密码就等于明文交出去。
	// 2026-08 实测 jwc / xk / uis 三个域名都是完整可验证的 *.jxnu.edu.cn 链
	// （cnTrus OV SSL CA，verify code 0），历史上「链不全」的前提已经不成立。
	// 学校将来再把链配坏，就该显式报错，而不是静默降级成不安全连接。
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	transport.MaxIdleConns = 16
	transport.MaxIdleConnsPerHost = 8
	transport.IdleConnTimeout = 90 * time.Second
	result := &JWCClient{
		client:   &http.Client{Jar: jar, Timeout: 30 * time.Second},
		username: username, password: password,
	}
	result.client.Transport = roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		// SjdJsfJfXfsFsdf may contain a comma. net/http quotes such cookie
		// values per RFC 6265, while this legacy ASP.NET application expects
		// the historical raw form used by browsers/requests. Restrict the
		// compatibility rewrite to the trusted JWC host.
		if err := applyLegacyJWCCookies(req); err != nil {
			return nil, err
		}
		return transport.RoundTrip(req)
	})
	return result
}

func applyLegacyJWCCookies(req *http.Request) error {
	if !strings.EqualFold(req.URL.Host, "jwc.jxnu.edu.cn") {
		return nil
	}
	parts := make([]string, 0, len(req.Cookies()))
	for _, cookie := range req.Cookies() {
		if strings.ContainsAny(cookie.Name+cookie.Value, "\r\n;") {
			return errors.New("教务会话 Cookie 含非法分隔符")
		}
		parts = append(parts, cookie.Name+"="+cookie.Value)
	}
	if len(parts) > 0 {
		req.Header.Set("Cookie", strings.Join(parts, "; "))
	}
	return nil
}

func (c *JWCClient) IsAuthed() bool {
	return c.hasCookie(authCookie)
}

func (c *JWCClient) hasCookie(name string) bool {
	return c.hasCookieAt(jwcBase, name)
}

func (c *JWCClient) hasCookieAt(base, name string) bool {
	u, _ := url.Parse(base)
	for _, cookie := range c.client.Jar.Cookies(u) {
		if cookie.Name == name && cookie.Value != "" {
			return true
		}
	}
	return false
}

// Ping performs one cheap authenticated GET to reset the ASP.NET session's idle
// timer. It reports an error when the response shows the session already lapsed,
// so the caller can log it; the next real query re-logs in either way.
func (c *JWCClient) Ping(ctx context.Context) error {
	_, body, err := c.do(ctx, http.MethodGet, jwcBase+"/", nil, nil)
	if err != nil {
		return err
	}
	if looksLoggedOut(body) {
		c.resetSession()
		return errors.New("教务会话已失效")
	}
	return nil
}

func (c *JWCClient) resetSession() {
	jar, _ := cookiejar.New(nil)
	c.client.Jar = jar
}

func (c *JWCClient) Login(ctx context.Context) error {
	if c.username == "" || c.password == "" {
		return errors.New("未配置教务账号或密码")
	}
	var lastErr error
	for attempt := 1; attempt <= 5; attempt++ {
		if err := c.loginOnce(ctx); err == nil && c.IsAuthed() {
			return nil
		} else if err != nil {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	if lastErr != nil {
		return fmt.Errorf("CAS 登录失败: %w", lastErr)
	}
	return errors.New("CAS 登录完成但未取得教务会话")
}

func (c *JWCClient) loginOnce(ctx context.Context) error {
	// Always enter through the application and discover the real CAS service
	// from the redirect landing URL. The naked /sso/login.aspx URL is not the
	// service CAS must ticket: JWC injects a targetUrl that its LoginAccount
	// handler later consumes to establish the application session.
	discovery, _, err := c.do(ctx, http.MethodGet, jwcBase+"/sso/login.aspx", nil, nil)
	if err != nil {
		return err
	}
	service := ""
	if landed, parseErr := url.Parse(discovery.finalURL); parseErr == nil {
		service = htmlstd.UnescapeString(landed.Query().Get("service"))
	}
	if service == "" {
		service = c.service
	}
	serviceURL, parseErr := url.Parse(service)
	if parseErr != nil || serviceURL.Scheme != "https" || !strings.EqualFold(serviceURL.Host, "jwc.jxnu.edu.cn") {
		return errors.New("未能从教务入口发现可信的 CAS service")
	}
	c.service = service
	loginURL := casBase + "/login?service=" + url.QueryEscape(service)
	_, page, err := c.do(ctx, http.MethodGet, loginURL, nil, nil)
	if err != nil {
		return err
	}
	doc, err := parseHTML(page)
	if err != nil {
		return err
	}
	execution := hiddenValue(doc, "execution")
	if execution == "" {
		execution = "e1s1"
	}
	_, publicKey, err := c.do(ctx, http.MethodGet, casBase+"/jwt/publicKey", nil, nil)
	if err != nil {
		return err
	}
	encrypted, err := encryptCASPassword(c.password, strings.TrimSpace(publicKey))
	if err != nil {
		return err
	}
	form := url.Values{
		"username": {c.username}, "password": {encrypted}, "execution": {execution},
		"_eventId": {"submit"}, "geolocation": {""}, "currentMenu": {"1"}, "failN": {"-1"},
		"mfaState": {""}, "rememberMe": {"false"}, "trustAgent": {""}, "fpVisitorId": {""},
	}
	headers := http.Header{"Referer": {loginURL}, "Origin": {"https://uis.jxnu.edu.cn"}}
	result, responseBody, err := c.do(ctx, http.MethodPost, loginURL, form, headers)
	if err != nil {
		return err
	}
	if landing, parseErr := url.Parse(result.finalURL); parseErr == nil && landing.Host == "uis.jxnu.edu.cn" && strings.Contains(landing.Path, "/cas/login") {
		message := "CAS 拒绝登录"
		if strings.Contains(responseBody, "验证码") {
			message += "（可能需要验证码）"
		}
		return errors.New(message)
	}
	// Some Go/CAS redirect combinations stop at the SSO consumer after it has
	// set the application cookies. Explicitly warming the portal completes the
	// same initialization that requests follows to /Portal/Index.aspx.
	if landing, parseErr := url.Parse(result.finalURL); parseErr == nil && landing.Host == "jwc.jxnu.edu.cn" && landing.Path != "/Portal/Index.aspx" {
		if _, _, warmErr := c.do(ctx, http.MethodGet, jwcBase+"/Portal/Index.aspx", nil, http.Header{"Referer": {result.finalURL}}); warmErr != nil {
			return fmt.Errorf("初始化教务门户: %w", warmErr)
		}
	}
	if !c.IsAuthed() {
		return errors.New("CAS 登录完成但教务会话 Cookie 缺失")
	}
	return nil
}

type httpResult struct {
	status   int
	finalURL string
}

func (c *JWCClient) do(ctx context.Context, method, target string, form url.Values, headers http.Header) (httpResult, string, error) {
	var body *strings.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	} else {
		body = strings.NewReader("")
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return httpResult{}, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Accept", "*/*")
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	for key, values := range headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return httpResult{}, "", err
	}
	raw, readErr := readLimited(resp.Body, maxHTMLBytes)
	resp.Body.Close()
	result := httpResult{status: resp.StatusCode, finalURL: resp.Request.URL.String()}
	if readErr != nil {
		return result, "", readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return result, string(raw), fmt.Errorf("%s HTTP %d", target, resp.StatusCode)
	}
	return result, decodeSchoolHTML(raw, resp.Header.Get("Content-Type")), nil
}

func encryptCASPassword(password, publicKeyPEM string) (string, error) {
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil {
		return "", errors.New("CAS 公钥不是 PEM")
	}
	var key *rsa.PublicKey
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err == nil {
		key, _ = parsed.(*rsa.PublicKey)
	}
	if key == nil {
		if parsedPKCS1, pkcsErr := x509.ParsePKCS1PublicKey(block.Bytes); pkcsErr == nil {
			key = parsedPKCS1
		} else if err == nil {
			err = pkcsErr
		}
	}
	if key == nil {
		return "", fmt.Errorf("解析 CAS RSA 公钥: %w", err)
	}
	ciphertext, err := rsa.EncryptPKCS1v15(rand.Reader, key, []byte(password))
	if err != nil {
		return "", err
	}
	return "__RSA__" + base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (c *JWCClient) FetchStudent(ctx context.Context, sid, targetTerm string) (StudentAggregate, error) {
	if !c.IsAuthed() {
		if err := c.Login(ctx); err != nil {
			return StudentAggregate{}, err
		}
	}
	pageURL := studentScheduleURL(sid)
	getPage := func() (string, error) {
		_, body, err := c.do(ctx, http.MethodGet, pageURL, nil, http.Header{"Referer": {jwcBase + "/"}})
		return body, err
	}
	html, err := getPage()
	if err != nil {
		return StudentAggregate{}, err
	}
	if looksLoggedOut(html) {
		c.resetSession()
		if err := c.Login(ctx); err != nil {
			return StudentAggregate{}, err
		}
		html, err = getPage()
		if err != nil {
			return StudentAggregate{}, err
		}
	}
	if looksLoggedOut(html) {
		return StudentAggregate{}, fmt.Errorf("重新登录后仍无权读取课表（响应 %d 字节；authCookie=%t；aspSession=%t）", len(html), c.IsAuthed(), c.hasCookie("ASP.NET_SessionId"))
	}
	semesters, err := listJWCSemesters(html)
	if err != nil {
		return StudentAggregate{}, err
	}
	planning := choosePlanningTerm(semesters, targetTerm)
	if planning == nil {
		labels := make([]string, 0, len(semesters))
		for _, sem := range semesters {
			labels = append(labels, sem.Label)
		}
		return StudentAggregate{}, fmt.Errorf("指定学期 %q 不在教务可选列表中（可用：%s）", targetTerm, strings.Join(labels, "、"))
	}
	available := make([]string, 0, len(semesters))
	for _, sem := range semesters {
		available = append(available, sem.Label)
	}
	// A manually chosen planning term is also the upper bound. Newer terms are
	// excluded so future/pre-created pages cannot leak into earned-credit totals.
	selectedIndex := 0
	for i := range semesters {
		if semesters[i].Value == planning.Value {
			selectedIndex = i
			break
		}
	}
	included := semesters
	if targetTerm != "" {
		included = semesters[selectedIndex:]
	}

	type pageData struct {
		details []DetailCourse
		table   *xhtml.Node
	}
	pages := map[string]pageData{}
	details, table, className, parseErr := parseStudentPage(html)
	if parseErr != nil {
		return StudentAggregate{}, parseErr
	}
	defaultValue := semesters[0].Value
	for _, sem := range semesters {
		if sem.Selected {
			defaultValue = sem.Value
			break
		}
	}
	pages[defaultValue] = pageData{details, table}

	// 往期学期走缓存：它们的已修课程不会再变，而每翻一页都要一次有状态的 POST。
	// planning 学期永远不查缓存（实时性就是这条链路的意义），defaultValue 那页也
	// 已经由上面的 GET 拿到了。
	cached := map[string][]DetailCourse{}
	for _, sem := range included {
		if sem.Value == planning.Value || sem.Value == defaultValue {
			continue
		}
		if courses, ok := c.termCache.Get(sid, sem.Value); ok {
			cached[sem.Value] = courses
		}
	}

	currentHTML := html
	for _, sem := range included {
		if _, ok := pages[sem.Value]; ok {
			continue
		}
		if _, ok := cached[sem.Value]; ok {
			continue
		}
		var loaded bool
		for attempt := 0; attempt < 2 && !loaded; attempt++ {
			doc, parseErr := parseHTML(currentHTML)
			if parseErr != nil {
				return StudentAggregate{}, parseErr
			}
			form := url.Values{
				"__EVENTTARGET": {""}, "__EVENTARGUMENT": {""}, "__VIEWSTATE": {hiddenValue(doc, "__VIEWSTATE")},
				"__VIEWSTATEGENERATOR": {hiddenValue(doc, "__VIEWSTATEGENERATOR")}, "__EVENTVALIDATION": {hiddenValue(doc, "__EVENTVALIDATION")},
				"_ctl6:ddlSterm": {sem.Value}, "_ctl6:btnSearch": {"确定"},
			}
			_, currentHTML, err = c.do(ctx, http.MethodPost, pageURL, form, http.Header{"Referer": {pageURL}})
			if err != nil {
				return StudentAggregate{}, err
			}
			if looksLoggedOut(currentHTML) {
				if err := c.Login(ctx); err != nil {
					return StudentAggregate{}, err
				}
				currentHTML, err = getPage()
				if err != nil {
					return StudentAggregate{}, err
				}
				continue
			}
			pageDetails, pageTable, pageClass, parseErr := parseStudentPage(currentHTML)
			if parseErr != nil {
				return StudentAggregate{}, parseErr
			}
			pages[sem.Value] = pageData{pageDetails, pageTable}
			if className == "" {
				className = pageClass
			}
			// 只缓存往期：planning 学期下次仍要实时拉。
			if sem.Value != planning.Value {
				c.termCache.Put(sid, sem.Value, pageDetails)
			}
			loaded = true
		}
		if !loaded {
			return StudentAggregate{}, fmt.Errorf("读取教务学期 %s 失败", sem.Label)
		}
	}

	labelOf := map[string]string{}
	for _, sem := range semesters {
		labelOf[sem.Value] = sem.Label
	}
	seenCourses := map[string]bool{}
	var courses []DetailCourse
	for i := len(included) - 1; i >= 0; i-- {
		sem := included[i]
		// 缓存命中的往期与实时取回的页面在这里合流，顺序仍按 included 从旧到新，
		// 所以 seenCourses 的「先出现者胜」去重语义与全量抓取时完全一致。
		semDetails, ok := cached[sem.Value]
		if !ok {
			page, hasPage := pages[sem.Value]
			if !hasPage {
				continue
			}
			semDetails = page.details
		}
		for _, detail := range semDetails {
			if detail.CourseNo == "" || seenCourses[detail.CourseNo] {
				continue
			}
			seenCourses[detail.CourseNo] = true
			detail.Semester = labelOf[sem.Value]
			courses = append(courses, detail)
		}
	}
	planningPage, ok := pages[planning.Value]
	if !ok {
		return StudentAggregate{}, fmt.Errorf("未取得指定学期 %s 的课表", planning.Label)
	}
	schedule := parseScheduleItems(planningPage.table, planningPage.details)
	return StudentAggregate{ClassName: className, Courses: courses, PlanningTerm: planning.Label,
		ScheduleItems: schedule, NoSchedule: len(schedule) == 0, AvailableTerms: available}, nil
}

func studentScheduleURL(sid string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(sid))
	// Match the legacy endpoint's own links exactly. In particular, retain the
	// base64 padding instead of percent-encoding it.
	return jwcBase + "/MyControl/All_Display.aspx?UserControl=Xfz_Kcb.ascx&UserType=Student&UserNum=" + encoded
}

func looksLoggedOut(raw string) bool {
	return (len(raw) < 120 && (strings.Contains(raw, "参数错误") || strings.Contains(raw, "请登录"))) || strings.Contains(raw, "未登录系统")
}

func listJWCSemesters(raw string) ([]SemesterChoice, error) {
	doc, err := parseHTML(raw)
	if err != nil {
		return nil, err
	}
	selectNode := findFirst(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "select") && attr(n, "name") == "_ctl6:ddlSterm"
	})
	if selectNode == nil {
		return nil, errors.New("教务课表没有学期下拉框，页面结构可能已变化")
	}
	options := findAll(selectNode, func(n *xhtml.Node) bool { return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "option") })
	result := make([]SemesterChoice, 0, len(options))
	for _, option := range options {
		value, label := attr(option, "value"), nodeText(option)
		if value != "" && label != "" {
			result = append(result, SemesterChoice{Value: value, Label: label, Selected: hasAttr(option, "selected")})
		}
	}
	if len(result) == 0 {
		return nil, errors.New("教务学期下拉框为空")
	}
	return result, nil
}

func choosePlanningTerm(semesters []SemesterChoice, target string) *SemesterChoice {
	if target != "" {
		for i := range semesters {
			if semesters[i].Label == target {
				return &semesters[i]
			}
		}
		return nil
	}
	for i := range semesters {
		if semesters[i].Selected {
			return &semesters[i]
		}
	}
	return &semesters[0]
}

func parseStudentPage(raw string) ([]DetailCourse, *xhtml.Node, string, error) {
	doc, err := parseHTML(raw)
	if err != nil {
		return nil, nil, "", err
	}
	detailTable := findTable(doc, "_ctl6_dgStudentLesson")
	mainTable := findTable(doc, "_ctl6_NewKcb")
	details := parseDetailCourses(parseTableRows(detailTable))
	return details, mainTable, parseUserClass(doc), nil
}

func parseUserClass(doc *xhtml.Node) string {
	node := findFirst(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.Contains(attr(n, "id"), "lblUserInfor")
	})
	text := nodeText(node)
	re := regexp.MustCompile(`班级名称[:：]\s*(.+?)\s+学号[:：]`)
	match := re.FindStringSubmatch(text)
	if len(match) > 1 {
		return cleanText(match[1])
	}
	return ""
}

func findTable(doc *xhtml.Node, id string) *xhtml.Node {
	anchor := findFirst(doc, func(n *xhtml.Node) bool { return n.Type == xhtml.ElementNode && attr(n, "id") == id })
	if anchor == nil {
		return nil
	}
	if strings.EqualFold(anchor.Data, "table") {
		return anchor
	}
	return findFirst(anchor, func(n *xhtml.Node) bool { return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "table") })
}

type tableCell struct {
	RowSpan, ColSpan int
	Lines            []string
	Text             string
}
type placement struct {
	Cell                                 *tableCell
	RowIndex, ColIndex, RowSpan, ColSpan int
}

func parseTableRows(table *xhtml.Node) [][]*tableCell {
	if table == nil {
		return nil
	}
	trs := findAll(table, func(n *xhtml.Node) bool {
		if n.Type != xhtml.ElementNode || !strings.EqualFold(n.Data, "tr") {
			return false
		}
		for parent := n.Parent; parent != nil; parent = parent.Parent {
			if strings.EqualFold(parent.Data, "table") {
				return parent == table
			}
		}
		return false
	})
	rows := make([][]*tableCell, 0, len(trs))
	for _, tr := range trs {
		var row []*tableCell
		for _, cell := range directCells(tr) {
			row = append(row, &tableCell{RowSpan: parsePositiveAttr(cell, "rowspan"), ColSpan: parsePositiveAttr(cell, "colspan"), Lines: nodeLines(cell), Text: nodeText(cell)})
		}
		rows = append(rows, row)
	}
	return rows
}

func analyzeTable(rows [][]*tableCell) ([][]*tableCell, []placement) {
	grid := make([][]*tableCell, 0, len(rows))
	var placements []placement
	for rowIndex, row := range rows {
		for len(grid) <= rowIndex {
			grid = append(grid, nil)
		}
		colIndex := 0
		for _, cell := range row {
			for colIndex < len(grid[rowIndex]) && grid[rowIndex][colIndex] != nil {
				colIndex++
			}
			placements = append(placements, placement{cell, rowIndex, colIndex, cell.RowSpan, cell.ColSpan})
			for rowOffset := 0; rowOffset < cell.RowSpan; rowOffset++ {
				targetRow := rowIndex + rowOffset
				for len(grid) <= targetRow {
					grid = append(grid, nil)
				}
				need := colIndex + cell.ColSpan
				for len(grid[targetRow]) < need {
					grid[targetRow] = append(grid[targetRow], nil)
				}
				for colOffset := 0; colOffset < cell.ColSpan; colOffset++ {
					grid[targetRow][colIndex+colOffset] = cell
				}
			}
			colIndex += cell.ColSpan
		}
	}
	return grid, placements
}

func parseDetailCourses(rows [][]*tableCell) []DetailCourse {
	var result []DetailCourse
	for _, row := range rows[minimum(1, len(rows)):] {
		values := make([]string, len(row))
		for i, cell := range row {
			values[i] = cleanText(strings.Join(cell.Lines, " "))
			if values[i] == "" {
				values[i] = cell.Text
			}
		}
		if len(values) < 5 {
			continue
		}
		result = append(result, DetailCourse{CourseNo: values[0], CourseName: values[1], WeeklyHours: values[2], TeachingClass: values[3], Teacher: values[4]})
	}
	return result
}

type courseChunk struct{ CourseName, Location, TeachingClass string }

func parseCourseChunks(cell *tableCell) []courseChunk {
	queue := append([]string(nil), cell.Lines...)
	var chunks []courseChunk
	for len(queue) > 0 {
		courseName := cleanText(queue[0])
		queue = queue[1:]
		if courseName == "" {
			continue
		}
		location := ""
		if len(queue) > 0 && isLocationLine(queue[0]) {
			location = extractLocation(queue[0])
			queue = queue[1:]
		}
		teachingClass := ""
		if len(queue) > 0 && !isLocationLine(queue[0]) {
			descriptor := cleanText(queue[0])
			queue = queue[1:]
			if left, right, ok := splitTeachingClassAndNext(descriptor); ok {
				teachingClass = left
				queue = append([]string{right}, queue...)
			} else {
				teachingClass = descriptor
			}
		}
		if location == "" && teachingClass == "" && isPlaceholderCourse(courseName) {
			continue
		}
		chunks = append(chunks, courseChunk{courseName, location, teachingClass})
	}
	return chunks
}

// 课表网格解析对每个学生的每个单元格都要跑一遍，正则在包级编译一次。
var (
	locationLinePattern     = regexp.MustCompile(`^[（(]\s*.+?\s*[)）]$`)
	placeholderCoursePatten = regexp.MustCompile(`^(?:\d{2}级.*班|教工.*班|合班.*班)$`)
	placeholderClassPattern = regexp.MustCompile(`#\d+班\.?$`)
	noonDividerPattern      = regexp.MustCompile(`中\s*午`)
)

func isLocationLine(value string) bool {
	return locationLinePattern.MatchString(cleanText(value))
}
func extractLocation(value string) string {
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(cleanText(value), "（"), "("), "）"), ")"))
}
func teachingClassDescriptor(value string) bool {
	value = cleanText(value)
	return strings.Contains(value, "班") || strings.HasPrefix(value, "教工") || strings.HasPrefix(value, "合班")
}
func isPlaceholderCourse(value string) bool {
	value = cleanText(value)
	return placeholderCoursePatten.MatchString(value) || placeholderClassPattern.MatchString(value)
}
func splitTeachingClassAndNext(value string) (string, string, bool) {
	parts := strings.SplitN(cleanText(value), "、", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	left, right := cleanText(parts[0]), cleanText(parts[1])
	return left, right, left != "" && right != "" && teachingClassDescriptor(left) && !isLocationLine(right)
}

func normalizeKeyPart(value string) string { return strings.Join(strings.Fields(cleanText(value)), "") }
func detailKey(name, class string) string {
	return normalizeKeyPart(name) + "||" + normalizeKeyPart(class)
}

func matchDetail(item courseChunk, details []DetailCourse) *DetailCourse {
	for i := range details {
		if detailKey(details[i].CourseName, details[i].TeachingClass) == detailKey(item.CourseName, item.TeachingClass) {
			return &details[i]
		}
	}
	var names []*DetailCourse
	for i := range details {
		if normalizeKeyPart(details[i].CourseName) == normalizeKeyPart(item.CourseName) {
			names = append(names, &details[i])
		}
	}
	if len(names) == 1 {
		return names[0]
	}
	if len(names) > 1 && item.TeachingClass != "" {
		current := normalizeKeyPart(item.TeachingClass)
		for _, detail := range names {
			candidate := normalizeKeyPart(detail.TeachingClass)
			if strings.Contains(current, candidate) || strings.Contains(candidate, current) {
				return detail
			}
		}
	}
	if len(names) > 0 {
		return names[0]
	}
	return nil
}

func parseScheduleItems(mainTable *xhtml.Node, details []DetailCourse) []ScheduleItem {
	rows := parseTableRows(mainTable)
	grid, placements := analyzeTable(rows)
	dayColumns := map[int]struct {
		index int
		label string
	}{}
	if len(grid) > 0 {
		for column, cell := range grid[0] {
			if cell != nil {
				for i, label := range dayLabels {
					if cell.Text == label {
						dayColumns[column] = struct {
							index int
							label string
						}{i + 1, label}
					}
				}
			}
		}
	}
	rowPeriods := map[int][]int{}
	for rowIndex, row := range grid {
		var texts []string
		for _, cell := range row {
			if cell != nil {
				texts = append(texts, cell.Text)
			}
		}
		joined := strings.Join(texts, " ")
		if noonDividerPattern.MatchString(joined) || strings.Contains(joined, "课表说明") {
			continue
		}
		label := ""
		if len(row) > 1 && row[1] != nil {
			label = row[1].Text
		} else if len(row) > 0 && row[0] != nil {
			label = row[0].Text
		}
		if periods := periodsFromLabel(label); periods != nil {
			rowPeriods[rowIndex] = periods
		}
	}
	var raw []ScheduleItem
	for _, place := range placements {
		day, ok := dayColumns[place.ColIndex]
		if !ok {
			continue
		}
		periodSet := map[int]bool{}
		for offset := 0; offset < place.RowSpan; offset++ {
			for _, period := range rowPeriods[place.RowIndex+offset] {
				periodSet[period] = true
			}
		}
		if len(periodSet) == 0 {
			continue
		}
		periods := make([]int, 0, len(periodSet))
		for period := range periodSet {
			periods = append(periods, period)
		}
		sort.Ints(periods)
		for _, chunk := range parseCourseChunks(place.Cell) {
			detail := matchDetail(chunk, details)
			item := ScheduleItem{CourseName: chunk.CourseName, Location: chunk.Location, DayOfWeek: day.index, DayLabel: day.label,
				StartPeriod: periods[0], EndPeriod: periods[len(periods)-1], TeachingClass: chunk.TeachingClass}
			if detail != nil {
				item.Teacher = detail.Teacher
				item.CourseNo = detail.CourseNo
				item.WeeklyHours = detail.WeeklyHours
			}
			raw = append(raw, item)
		}
	}
	return mergeScheduleItems(raw)
}

func periodsFromLabel(label string) []int {
	switch strings.Join(strings.Fields(label), "") {
	case "12":
		return []int{1, 2}
	case "3":
		return []int{3}
	case "4":
		return []int{4}
	case "5":
		return []int{5}
	case "67":
		return []int{6, 7}
	case "89":
		return []int{8, 9}
	case "晚上":
		return []int{10, 11}
	}
	return nil
}

func mergeScheduleItems(items []ScheduleItem) []ScheduleItem {
	groups := map[string][]ScheduleItem{}
	for _, item := range items {
		key := strings.Join([]string{strconv.Itoa(item.DayOfWeek), item.CourseName, item.Location, item.TeachingClass, item.Teacher, item.CourseNo, item.WeeklyHours}, "\x00")
		groups[key] = append(groups[key], item)
	}
	var result []ScheduleItem
	for _, group := range groups {
		sort.Slice(group, func(i, j int) bool {
			if group[i].StartPeriod != group[j].StartPeriod {
				return group[i].StartPeriod < group[j].StartPeriod
			}
			return group[i].EndPeriod < group[j].EndPeriod
		})
		var merged []ScheduleItem
		for _, item := range group {
			if len(merged) > 0 && merged[len(merged)-1].EndPeriod+1 >= item.StartPeriod {
				if item.EndPeriod > merged[len(merged)-1].EndPeriod {
					merged[len(merged)-1].EndPeriod = item.EndPeriod
				}
			} else {
				merged = append(merged, item)
			}
		}
		result = append(result, merged...)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].DayOfWeek != result[j].DayOfWeek {
			return result[i].DayOfWeek < result[j].DayOfWeek
		}
		if result[i].StartPeriod != result[j].StartPeriod {
			return result[i].StartPeriod < result[j].StartPeriod
		}
		if result[i].EndPeriod != result[j].EndPeriod {
			return result[i].EndPeriod < result[j].EndPeriod
		}
		return result[i].CourseName < result[j].CourseName
	})
	return result
}

func minimum(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func decodeSchoolHTML(raw []byte, contentType string) string {
	encoding, _, _ := charset.DetermineEncoding(raw, contentType)
	reader := encoding.NewDecoder().Reader(bytes.NewReader(raw))
	decoded, err := readLimited(reader, maxHTMLBytes)
	if err != nil {
		return strings.ToValidUTF8(string(raw), "")
	}
	return string(decoded)
}
