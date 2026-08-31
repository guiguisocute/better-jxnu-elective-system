package app

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	xhtml "golang.org/x/net/html"
)

const xkBase = "https://xk.jxnu.edu.cn"

// 容量抓取一轮 1400+ 门课、每门十几个班，intPtrAt 会被调用几万次；
// 正则必须在包级编译一次，不能每次调用都重编译。
var integerCellPattern = regexp.MustCompile(`^-?\d+$`)

// 连续这么多门课都取不到结果，就认定会话已经废了，提前收工。
// 教务会话掉线时逐门跑完 1400 次注定失败的请求要十几分钟，还会把真正的原因
// 埋在几千行日志里（2026-07 的「容量全 0」就是这么难查的）。
const capacityAbortAfterConsecutiveFailures = 25

type CapacityClass struct {
	ClassID   string `json:"bjh"`
	ClassName string `json:"className"`
	Teacher   string `json:"teacher"`
	Enrolled  *int   `json:"enrolled"`
	Remaining *int   `json:"remaining"`
	Full      bool   `json:"full"`
}
type CapacityCourse struct {
	CourseID string          `json:"kch"`
	Blocked  bool            `json:"blocked"`
	Classes  []CapacityClass `json:"classes"`
	Name     string          `json:"name"`
}
type CapacitySnapshot struct {
	Semester  string           `json:"semester"`
	FetchedAt string           `json:"fetched_at"`
	SourceURL string           `json:"sourceUrl"`
	Config    map[string]any   `json:"config"`
	Courses   []CapacityCourse `json:"courses"`
	Summary   struct {
		Total   int `json:"total"`
		Visible int `json:"visible"`
		Blocked int `json:"blocked"`
	} `json:"summary"`
}

type XKClient struct {
	client             *http.Client
	username, password string
}

func NewXKClient(username, password string) *XKClient {
	jar, _ := cookiejar.New(nil)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	transport.MaxIdleConnsPerHost = 8
	return &XKClient{client: &http.Client{Jar: jar, Transport: transport, Timeout: 30 * time.Second}, username: username, password: password}
}
func (c *XKClient) do(ctx context.Context, method, target string, form url.Values, headers http.Header) (string, error) {
	body := strings.NewReader("")
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", backendAgent)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	for k, vs := range headers {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	raw, readErr := readLimited(resp.Body, maxHTMLBytes)
	resp.Body.Close()
	if readErr != nil {
		return "", readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return "", fmt.Errorf("%s HTTP %d", target, resp.StatusCode)
	}
	return decodeSchoolHTML(raw, resp.Header.Get("Content-Type")), nil
}
func (c *XKClient) Login(ctx context.Context) error {
	if c.username == "" || c.password == "" {
		return errors.New("未配置教务账号或密码")
	}
	target := base64.StdEncoding.EncodeToString([]byte(xkBase + "/Portal/default.aspx"))
	service := xkBase + "/sso/Memberlogin.aspx?targetUrl={base64}" + target
	loginURL := casBase + "/login?service=" + url.QueryEscape(service)
	page, err := c.do(ctx, http.MethodGet, loginURL, nil, nil)
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
	publicKey, err := c.do(ctx, http.MethodGet, casBase+"/jwt/publicKey", nil, nil)
	if err != nil {
		return err
	}
	password, err := encryptCASPassword(c.password, strings.TrimSpace(publicKey))
	if err != nil {
		return err
	}
	form := url.Values{"username": {c.username}, "password": {password}, "execution": {execution}, "_eventId": {"submit"}, "geolocation": {""}, "currentMenu": {"1"}, "failN": {"-1"}, "mfaState": {""}, "rememberMe": {"false"}, "trustAgent": {""}, "fpVisitorId": {""}}
	if _, err = c.do(ctx, http.MethodPost, loginURL, form, http.Header{"Referer": {loginURL}, "Origin": {"https://uis.jxnu.edu.cn"}}); err != nil {
		return err
	}
	if _, err = c.do(ctx, http.MethodGet, xkBase+"/Portal/default.aspx", nil, nil); err != nil {
		return err
	}
	u, _ := url.Parse(xkBase)
	for _, cookie := range c.client.Jar.Cookies(u) {
		if cookie.Name == "ASP.NET_SessionId" && cookie.Value != "" {
			return nil
		}
	}
	return errors.New("选课系统未下发 ASP.NET_SessionId")
}
func (c *XKClient) SystemConfig(ctx context.Context) map[string]any {
	raw, err := c.do(ctx, http.MethodGet, xkBase+"/Default_config.aspx", nil, nil)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"len": len(raw), "excerpt": truncate(cleanTextFromHTML(raw), 600)}
}
func (c *XKClient) ChangeClass(ctx context.Context, courseID, urlTemplate string) (CapacityCourse, error) {
	if err := validateCapacityURL(urlTemplate); err != nil {
		return CapacityCourse{}, err
	}
	target := strings.ReplaceAll(urlTemplate, "{courseId}", url.QueryEscape(courseID))
	parsed, parseErr := url.Parse(target)
	referer := xkBase + "/"
	if parseErr != nil {
		return CapacityCourse{}, fmt.Errorf("容量嗅探 URL 代入课程号后不可解析: %w", parseErr)
	}
	if slash := strings.LastIndex(parsed.Path, "/"); slash >= 0 {
		referer = parsed.Scheme + "://" + parsed.Host + parsed.Path[:slash+1]
	}
	raw, err := c.do(ctx, http.MethodGet, target, nil, http.Header{"Referer": {referer}})
	if err != nil {
		return CapacityCourse{}, err
	}
	return ParseChangeClass(raw, courseID), nil
}

func ParseChangeClass(raw, courseID string) CapacityCourse {
	record := CapacityCourse{CourseID: courseID, Blocked: strings.Contains(raw, "对不起") && strings.Contains(raw, "落选"), Classes: []CapacityClass{}}
	doc, err := parseHTML(raw)
	if err != nil {
		return record
	}
	for _, tr := range findAll(doc, func(n *xhtml.Node) bool { return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "tr") }) {
		classID := ""
		for _, a := range findAll(tr, func(n *xhtml.Node) bool { return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "a") }) {
			if parsed := htmlURL(attr(a, "href")); parsed != nil && parsed.Query().Get("bjh") != "" {
				classID = parsed.Query().Get("bjh")
				break
			}
		}
		if classID == "" {
			continue
		}
		cells := directCells(tr)
		var values []string
		for _, cell := range cells {
			if text := nodeText(cell); text != "" {
				values = append(values, text)
			}
		}
		if len(values) == 0 {
			continue
		}
		if _, err := strconv.Atoi(values[0]); err != nil {
			continue
		}
		full := false
		for _, value := range values {
			if value == "班级容量已满" {
				full = true
				break
			}
		}
		record.Classes = append(record.Classes, CapacityClass{ClassID: classID, ClassName: stringAt(values, 1), Teacher: stringAt(values, 2), Enrolled: intPtrAt(values, 4), Remaining: intPtrAt(values, 5), Full: full})
	}
	return record
}
func stringAt(values []string, index int) string {
	if index >= 0 && index < len(values) {
		return values[index]
	}
	return ""
}
func intPtrAt(values []string, index int) *int {
	if index < 0 || index >= len(values) {
		return nil
	}
	if !integerCellPattern.MatchString(strings.TrimSpace(values[index])) {
		return nil
	}
	n, _ := strconv.Atoi(strings.TrimSpace(values[index]))
	return &n
}
func cleanTextFromHTML(raw string) string {
	doc, err := parseHTML(raw)
	if err != nil {
		return cleanText(raw)
	}
	return nodeText(doc)
}

func LoadCourseNames(path string) ([]string, map[string]string, error) {
	var rows []ScheduleRow
	if err := readJSONFile(path, &rows); err != nil {
		return nil, nil, err
	}
	names := map[string]string{}
	var order []string
	for _, row := range rows {
		id := strings.TrimSpace(row.CourseID)
		if id != "" {
			if _, ok := names[id]; !ok {
				names[id] = row.CourseName
				order = append(order, id)
			}
		}
	}
	return order, names, nil
}
func CrawlCapacity(ctx context.Context, client *XKClient, semester, formalPath, urlTemplate string, delay time.Duration, progress func(int, int, CapacityCourse)) (*CapacitySnapshot, error) {
	if err := client.Login(ctx); err != nil {
		return nil, err
	}
	courseIDs, names, err := LoadCourseNames(formalPath)
	if err != nil {
		return nil, err
	}
	snapshot := &CapacitySnapshot{Semester: semester, FetchedAt: time.Now().Format("2006-01-02 15:04:05"), SourceURL: urlTemplate, Config: client.SystemConfig(ctx), Courses: []CapacityCourse{}}
	fetch := func(ctx context.Context, courseID string) (CapacityCourse, error) {
		return client.ChangeClass(ctx, courseID, urlTemplate)
	}
	return crawlCapacityCourses(ctx, snapshot, courseIDs, names, fetch, delay, progress)
}

// crawlCapacityCourses 是抓取循环本体，抽出来是为了能脱离 CAS 登录单独测试中止逻辑。
func crawlCapacityCourses(ctx context.Context, snapshot *CapacitySnapshot, courseIDs []string, names map[string]string,
	fetch func(context.Context, string) (CapacityCourse, error), delay time.Duration, progress func(int, int, CapacityCourse)) (*CapacitySnapshot, error) {
	consecutiveFailures := 0
	var firstFailure error
	for i, id := range courseIDs {
		// delay 可以配成 0，那样下面的 select 不会执行，这里必须自己让出取消点，
		// 否则面板上的「取消」和进程退出都要等 1400 门课跑完。
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		record, fetchErr := fetch(ctx, id)
		if fetchErr != nil {
			consecutiveFailures++
			if firstFailure == nil {
				firstFailure = fetchErr
			}
			if progress != nil {
				progress(i+1, len(courseIDs), CapacityCourse{CourseID: id, Name: "ERROR: " + fetchErr.Error()})
			}
			if consecutiveFailures >= capacityAbortAfterConsecutiveFailures {
				return nil, fmt.Errorf("连续 %d 门课抓取失败（已处理 %d/%d），判定会话或选课阶段异常，提前中止；首个错误：%w",
					consecutiveFailures, i+1, len(courseIDs), firstFailure)
			}
			continue
		}
		consecutiveFailures = 0
		record.Name = names[id]
		snapshot.Courses = append(snapshot.Courses, record)
		if record.Blocked {
			snapshot.Summary.Blocked++
		} else if len(record.Classes) > 0 {
			snapshot.Summary.Visible++
		}
		if progress != nil {
			progress(i+1, len(courseIDs), record)
		}
		if delay > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}
	}
	snapshot.Summary.Total = len(snapshot.Courses)
	return snapshot, nil
}
func WriteJSON(path string, value any, mode os.FileMode) error {
	raw, err := json.MarshalIndent(value, "", " ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return atomicWrite(path, raw, mode)
}
