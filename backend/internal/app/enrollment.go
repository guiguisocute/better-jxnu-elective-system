package app

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	xhtml "golang.org/x/net/html"
)

const (
	kkapURL      = "https://jwc.jxnu.edu.cn/MyControl/Public_Kkap.aspx"
	backendAgent = "Mozilla/5.0 (compatible; JXNU-Elective-Go/2.0)"
	maxHTMLBytes = 32 << 20
	maxJSONBytes = 32 << 20
	// Public_Kkap occasionally takes longer than the configured interval. Never
	// hammer it in a zero-delay loop when that happens.
	//
	// 这个下限是抓取「结束之后」再等的固定间隔，当年一轮要 15–90 秒（海外抓取），
	// 5 秒相对可忽略。后端搬进校园网后一轮只要约 2.5 秒，5 秒的间隔反而成了
	// 周期里的大头（实测 7.5s 中占 5s）。降到 1 秒：既保证任意两次抓取之间
	// 一定有间隔、不会退化成紧循环，又让补退选期间的节奏真正跟上席位变化。
	minimumRefreshPause   = 1 * time.Second
	publicScheduleTimeout = 300 * time.Second
)

type ScheduleRow struct {
	Sequence     string `json:"序号"`
	Department   string `json:"单位名称"`
	CourseName   string `json:"课程名称"`
	ClassName    string `json:"班级名称"`
	Teacher      string `json:"任课教师"`
	Classroom    string `json:"教室"`
	Weekday      string `json:"星期"`
	Period       string `json:"节次"`
	EnrolledText string `json:"授课人数"`
	CourseID     string `json:"课程号"`
	ClassID      string `json:"班级号"`
	RawSemester  string `json:"学期"`
	CatalogID    any    `json:"CourseID,omitempty"`
	CourseInfo   any    `json:"课程信息,omitempty"`
	TeacherInfo  any    `json:"任课老师,omitempty"`
}

type SchoolTermOption struct {
	Label    string `json:"label"`
	Value    string `json:"value"`
	Semester string `json:"semester,omitempty"`
}

// TargetSemesterUnavailableError means the school has not published the
// configured term in Public_Kkap yet. It is an expected watcher state, not a
// failed synchronization attempt.
type TargetSemesterUnavailableError struct {
	TargetSemester string
	TargetTerm     string
	AvailableTerms []string
}

func (e *TargetSemesterUnavailableError) Error() string {
	available := "暂无"
	if len(e.AvailableTerms) > 0 {
		available = strings.Join(e.AvailableTerms, "、")
	}
	return fmt.Sprintf("KKAP 尚未开放目标学期 %s（%s）；当前可选：%s", e.TargetTerm, e.TargetSemester, available)
}

type TargetScheduleIncompleteError struct {
	TargetSemester string
	TargetTerm     string
	Cause          error
}

func (e *TargetScheduleIncompleteError) Error() string {
	return fmt.Sprintf("KKAP 已出现目标学期 %s（%s），但全量课表尚未就绪：%v", e.TargetTerm, e.TargetSemester, e.Cause)
}

func (e *TargetScheduleIncompleteError) Unwrap() error { return e.Cause }

type EnrollmentItem [4]any

type EnrollmentSnapshot struct {
	Version       int              `json:"version"`
	Semester      string           `json:"semester"`
	FetchedAt     string           `json:"fetchedAt"`
	SourceRows    int              `json:"sourceRows"`
	ClassCount    int              `json:"classCount"`
	ConflictCount int              `json:"conflictCount"`
	Items         []EnrollmentItem `json:"items"`
}

type enrollmentState struct {
	OK                bool    `json:"ok"`
	Refreshing        bool    `json:"refreshing"`
	LastAttemptAt     *string `json:"lastAttemptAt"`
	NextRefreshAt     string  `json:"nextRefreshAt"`
	RefreshIntervalMS int     `json:"refreshIntervalMs"`
	Error             *string `json:"error"`
	// PublicError 是 /api/enrollments 对外回显的那一份。
	// Error 里是原始 Go 错误串，包含学校的 URL、IP 和内部报错文本；
	// 那些只该进管理面板和日志，不该出现在任何人都能 curl 的接口上。
	PublicError *string             `json:"-"`
	Snapshot    *EnrollmentSnapshot `json:"-"`
}

// 采集失败时对外只说“暂时不可用”。具体原因看面板的同步状态或 journal。
const publicEnrollmentErrorMessage = "实时人数暂时不可用，请稍后再试"

type encodedResponse struct {
	raw  []byte
	gzip []byte
	etag string
}

type EnrollmentService struct {
	config *ConfigStore
	client *http.Client
	logger *slog.Logger
	mu     sync.RWMutex
	state  enrollmentState
	full   encodedResponse
	health encodedResponse
	wake   chan struct{}

	snapshotPath string
	lastPersist  time.Time
}

// NewPublicScheduleClient 返回一个只用来打 KKAP 公开页面的 http.Client。
// 采集器和探针都需要它，但它们不需要（也不应该）顺带构造一个 EnrollmentService：
// 那会读一次磁盘快照并打出一行“已载入实时人数磁盘快照”的假日志。
func NewPublicScheduleClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 8
	transport.MaxIdleConnsPerHost = 4
	transport.IdleConnTimeout = 90 * time.Second
	return &http.Client{Transport: transport, Jar: jar, Timeout: publicScheduleTimeout}
}

func NewEnrollmentService(config *ConfigStore, logger *slog.Logger) *EnrollmentService {
	service := &EnrollmentService{
		config:       config,
		logger:       logger,
		client:       NewPublicScheduleClient(),
		wake:         make(chan struct{}, 1),
		snapshotPath: filepath.Join(filepath.Dir(config.Path()), "enrollment_snapshot.json"),
	}
	service.loadSnapshot()
	return service
}

func (s *EnrollmentService) loadSnapshot() {
	var snapshot EnrollmentSnapshot
	if err := readJSONFile(s.snapshotPath, &snapshot); err != nil {
		return
	}
	fetchedAt, err := time.Parse(time.RFC3339, snapshot.FetchedAt)
	cfg := s.config.Get()
	target := cfg.LiveEnrollmentTarget()
	if target == "" || err != nil || time.Since(fetchedAt) > 24*time.Hour || snapshot.Semester != target || snapshot.ClassCount == 0 || len(snapshot.Items) != snapshot.ClassCount {
		return
	}
	now := time.Now()
	s.state = enrollmentState{OK: true, Refreshing: false, NextRefreshAt: now.UTC().Format(time.RFC3339), RefreshIntervalMS: cfg.EnrollmentRefreshSeconds * 1000, Snapshot: &snapshot}
	s.lastPersist = fetchedAt
	s.reencodeLocked()
	s.logger.Info("已载入实时人数磁盘快照", "semester", snapshot.Semester, "classes", snapshot.ClassCount, "ageSeconds", int(time.Since(fetchedAt).Seconds()))
}

func (s *EnrollmentService) persistSnapshot(snapshot *EnrollmentSnapshot) {
	if snapshot == nil || (!s.lastPersist.IsZero() && time.Since(s.lastPersist) < 30*time.Minute) {
		return
	}
	if err := WriteJSON(s.snapshotPath, snapshot, 0o600); err != nil {
		s.logger.Warn("持久化实时人数快照失败", "error", err)
		return
	}
	s.lastPersist = time.Now()
}

func (s *EnrollmentService) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *EnrollmentService) Run(ctx context.Context) {
	for {
		started := time.Now()
		cfg := s.config.Get()
		target := cfg.LiveEnrollmentTarget()
		if target == "" {
			s.disableForPreselect(started, cfg.EnrollmentRefreshSeconds)
			if !s.wait(ctx, time.Duration(cfg.EnrollmentRefreshSeconds)*time.Second) {
				return
			}
			continue
		}
		s.setAttempt(started, cfg.EnrollmentRefreshSeconds)
		snapshot, err := FetchEnrollmentSnapshot(ctx, s.client, target)
		// 把整轮耗时记下来：周期＝这段时间＋下面的 wait，出问题时能一眼看出
		// 是学校变慢了还是我们自己的间隔设置不对。
		elapsed := time.Since(started)
		if err != nil {
			s.logger.Error("实时人数刷新失败", "error", err, "elapsedMs", elapsed.Milliseconds())
		} else {
			s.logger.Info("实时人数刷新完成", "semester", snapshot.Semester, "classes", snapshot.ClassCount, "sourceRows", snapshot.SourceRows, "elapsedMs", elapsed.Milliseconds())
		}
		wait := time.Duration(cfg.EnrollmentRefreshSeconds)*time.Second - time.Since(started)
		if wait < minimumRefreshPause {
			wait = minimumRefreshPause
		}
		s.finishAttempt(snapshot, err, time.Now().Add(wait), cfg.EnrollmentRefreshSeconds)
		if err == nil {
			s.persistSnapshot(snapshot)
		}
		if !s.wait(ctx, wait) {
			return
		}
	}
}

func (s *EnrollmentService) wait(ctx context.Context, wait time.Duration) bool {
	if wait < minimumRefreshPause {
		wait = minimumRefreshPause
	}
	timer := time.NewTimer(wait)
	select {
	case <-ctx.Done():
		if !timer.Stop() {
			<-timer.C
		}
		return false
	case <-s.wake:
		if !timer.Stop() {
			<-timer.C
		}
		return true
	case <-timer.C:
		return true
	}
}

func (s *EnrollmentService) disableForPreselect(now time.Time, interval int) {
	message := "当前默认阶段为预选：预选目录不含实时人数，KKAP 轮询已按阶段关闭"
	s.mu.Lock()
	// 这条是阶段语义，不是故障详情，对外照原样显示。
	s.state = enrollmentState{
		OK: false, Refreshing: false, NextRefreshAt: now.Add(time.Duration(interval) * time.Second).UTC().Format(time.RFC3339),
		RefreshIntervalMS: interval * 1000, Error: &message, PublicError: &message,
	}
	s.reencodeLocked()
	s.mu.Unlock()
}

func (s *EnrollmentService) setAttempt(now time.Time, interval int) {
	stamp := now.UTC().Format(time.RFC3339)
	s.mu.Lock()
	s.state.Refreshing = true
	s.state.LastAttemptAt = &stamp
	s.state.NextRefreshAt = now.Add(time.Duration(interval) * time.Second).UTC().Format(time.RFC3339)
	s.state.RefreshIntervalMS = interval * 1000
	s.reencodeLocked()
	s.mu.Unlock()
}

func (s *EnrollmentService) finishAttempt(snapshot *EnrollmentSnapshot, err error, next time.Time, interval int) {
	s.mu.Lock()
	s.state.Refreshing = false
	s.state.NextRefreshAt = next.UTC().Format(time.RFC3339)
	s.state.RefreshIntervalMS = interval * 1000
	if err != nil {
		message := err.Error()
		public := publicEnrollmentErrorMessage
		s.state.Error = &message
		s.state.PublicError = &public
	} else {
		s.state.Snapshot = snapshot
		s.state.Error = nil
		s.state.PublicError = nil
	}
	s.state.OK = s.state.Snapshot != nil
	s.reencodeLocked()
	s.mu.Unlock()
}

func (s *EnrollmentService) reencodeLocked() {
	health := map[string]any{
		"ok": s.state.OK, "refreshing": s.state.Refreshing,
		"lastAttemptAt": s.state.LastAttemptAt, "nextRefreshAt": s.state.NextRefreshAt,
		"refreshIntervalMs": s.state.RefreshIntervalMS, "error": s.state.PublicError,
	}
	full := make(map[string]any, len(health)+8)
	for key, value := range health {
		full[key] = value
	}
	if snapshot := s.state.Snapshot; snapshot != nil {
		health["version"] = snapshot.Version
		health["semester"] = snapshot.Semester
		health["fetchedAt"] = snapshot.FetchedAt
		health["sourceRows"] = snapshot.SourceRows
		health["classCount"] = snapshot.ClassCount
		health["conflictCount"] = snapshot.ConflictCount
		for key, value := range health {
			full[key] = value
		}
		full["items"] = snapshot.Items
	}
	s.health = encodeResponse(health)
	s.full = encodeResponse(full)
}

func (s *EnrollmentService) Responses() (full, health encodedResponse, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.full, s.health, s.state.OK
}

func (s *EnrollmentService) Status() enrollmentState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state := s.state
	if state.Snapshot != nil {
		trimmed := *state.Snapshot
		trimmed.Items = nil
		state.Snapshot = &trimmed
	}
	return state
}

func FetchEnrollmentSnapshot(ctx context.Context, client *http.Client, semester string) (*EnrollmentSnapshot, error) {
	rows, err := FetchPublicSchedule(ctx, client, semester)
	if err != nil {
		return nil, err
	}
	type key struct{ course, class, teacher string }
	grouped := map[key]map[int]bool{}
	for _, row := range rows {
		n, err := strconv.Atoi(strings.TrimSpace(row.EnrolledText))
		if err != nil {
			continue
		}
		k := key{cleanText(row.CourseName), cleanText(row.ClassName), cleanText(row.Teacher)}
		if k.course == "" || k.class == "" {
			continue
		}
		if grouped[k] == nil {
			grouped[k] = map[int]bool{}
		}
		grouped[k][n] = true
	}
	keys := make([]key, 0, len(grouped))
	for k := range grouped {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].course != keys[j].course {
			return keys[i].course < keys[j].course
		}
		if keys[i].class != keys[j].class {
			return keys[i].class < keys[j].class
		}
		return keys[i].teacher < keys[j].teacher
	})
	items := make([]EnrollmentItem, 0, len(keys))
	conflicts := 0
	for _, k := range keys {
		counts := grouped[k]
		if len(counts) > 1 {
			conflicts++
		}
		max := 0
		for n := range counts {
			if n > max {
				max = n
			}
		}
		items = append(items, EnrollmentItem{k.course, k.class, k.teacher, max})
	}
	return &EnrollmentSnapshot{
		Version: 1, Semester: semester, FetchedAt: time.Now().UTC().Format(time.RFC3339),
		SourceRows: len(rows), ClassCount: len(items), ConflictCount: conflicts, Items: items,
	}, nil
}

func FetchPublicSchedule(ctx context.Context, client *http.Client, targetSemester string) ([]ScheduleRow, error) {
	target, ok := ResolveAcquisitionTarget(targetSemester)
	if !ok {
		return nil, fmt.Errorf("KKAP 目标学期不合法：%s", targetSemester)
	}
	targetTerm := target.AcademicTerm
	get, err := http.NewRequestWithContext(ctx, http.MethodGet, kkapURL, nil)
	if err != nil {
		return nil, err
	}
	get.Header.Set("User-Agent", backendAgent)
	response, err := client.Do(get)
	if err != nil {
		return nil, fmt.Errorf("打开 Public_Kkap: %w", err)
	}
	pageBytes, readErr := readLimited(response.Body, maxHTMLBytes)
	response.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Public_Kkap GET HTTP %d", response.StatusCode)
	}
	doc, err := parseHTML(string(pageBytes))
	if err != nil {
		return nil, err
	}
	viewstate := hiddenValue(doc, "__VIEWSTATE")
	if viewstate == "" {
		return nil, errors.New("Public_Kkap 未返回 __VIEWSTATE")
	}
	termOptions := parseSchoolTermOptions(doc)
	termValue := ""
	availableTerms := make([]string, 0, len(termOptions))
	for _, option := range termOptions {
		if option.Label != "" {
			availableTerms = append(availableTerms, option.Label)
		}
		if option.Semester == targetSemester || option.Label == targetTerm {
			termValue = option.Value
		}
	}
	if termValue == "" {
		return nil, &TargetSemesterUnavailableError{TargetSemester: targetSemester, TargetTerm: targetTerm, AvailableTerms: availableTerms}
	}
	form := url.Values{
		"__VIEWSTATE": {viewstate}, "__VIEWSTATEGENERATOR": {hiddenValue(doc, "__VIEWSTATEGENERATOR")},
		"__EVENTVALIDATION": {hiddenValue(doc, "__EVENTVALIDATION")},
		"ddlSterm":          {termValue}, "ddlCollege": {"不限"}, "ddlWeek": {"不限"}, "ddlJC": {"不限"},
		"txtJS": {""}, "txtKc": {""}, "txtTeacher": {""}, "btnSearch": {"查询"},
	}
	post, err := http.NewRequestWithContext(ctx, http.MethodPost, kkapURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	post.Header.Set("User-Agent", backendAgent)
	post.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	post.Header.Set("Referer", kkapURL)
	post.Header.Set("Origin", "https://jwc.jxnu.edu.cn")
	response, err = client.Do(post)
	if err != nil {
		return nil, fmt.Errorf("查询 Public_Kkap: %w", err)
	}
	defer response.Body.Close()
	// 状态码先判，再决定要不要解析——流式解析没法「读完再回头看状态」。
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Public_Kkap POST HTTP %d", response.StatusCode)
	}
	rows, err := ParsePublicScheduleFrom(&cappedReader{reader: response.Body, limit: maxHTMLBytes})
	if err != nil {
		return nil, &TargetScheduleIncompleteError{TargetSemester: targetSemester, TargetTerm: targetTerm, Cause: err}
	}
	if err := validateScheduleSemester(rows, targetSemester); err != nil {
		return nil, err
	}
	return rows, nil
}

func parseSchoolTermOptions(doc *xhtml.Node) []SchoolTermOption {
	var options []SchoolTermOption
	for _, selectNode := range findAll(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "select") &&
			(attr(n, "name") == "ddlSterm" || attr(n, "id") == "ddlSterm")
	}) {
		for _, option := range findAll(selectNode, func(n *xhtml.Node) bool {
			return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "option")
		}) {
			value := strings.TrimSpace(attr(option, "value"))
			label := nodeText(option)
			semester, _ := SemesterFromSchoolDate(value)
			options = append(options, SchoolTermOption{Label: label, Value: value, Semester: semester})
		}
	}
	return options
}

func validateScheduleSemester(rows []ScheduleRow, targetSemester string) error {
	if len(rows) == 0 {
		return errors.New("KKAP 没有返回开课安排")
	}
	for i, row := range rows {
		semester, ok := SemesterFromSchoolDate(row.RawSemester)
		if !ok {
			return fmt.Errorf("KKAP 第 %d 行缺少可识别的学期：%q", i+1, row.RawSemester)
		}
		if semester != targetSemester {
			return fmt.Errorf("KKAP 返回了错误学期：目标 %s，第 %d 行实际为 %s（%s）", targetSemester, i+1, semester, row.RawSemester)
		}
	}
	return nil
}

func ParsePublicSchedule(raw string) ([]ScheduleRow, error) {
	doc, err := parseHTML(raw)
	if err != nil {
		return nil, err
	}
	return scheduleRowsFromDoc(doc)
}

// ParsePublicScheduleFrom 直接从响应流解析，不先把整页读成 []byte 再转 string。
// KKAP 全量页 9MB，原来的做法要在内存里躺三份（body 缓冲、[]byte、string），
// 而且必须等最后一个字节到齐才开始解析。改成流式后解析与传输天然重叠，
// 校园内网下 0.5 秒的传输窗口正好把解析吃掉。
func ParsePublicScheduleFrom(reader io.Reader) ([]ScheduleRow, error) {
	doc, err := xhtml.Parse(reader)
	if err != nil {
		return nil, err
	}
	return scheduleRowsFromDoc(doc)
}

func scheduleRowsFromDoc(doc *xhtml.Node) ([]ScheduleRow, error) {
	trs := findAll(doc, func(n *xhtml.Node) bool { return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "tr") })
	rows := make([]ScheduleRow, 0, len(trs))
	for _, tr := range trs {
		cells := directCells(tr)
		if len(cells) < 9 {
			continue
		}
		values := make([]string, len(cells))
		for i, cell := range cells {
			values[i] = nodeText(cell)
		}
		if _, err := strconv.Atoi(values[0]); err != nil {
			continue
		}
		var courseID, classID, semester string
		for _, link := range findAll(tr, func(n *xhtml.Node) bool { return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "a") }) {
			href := htmlURL(attr(link, "href"))
			if href == nil {
				continue
			}
			query := href.Query()
			if courseID == "" {
				courseID = query.Get("kch")
			}
			if classID == "" {
				classID = query.Get("bjh")
			}
			if semester == "" {
				semester = query.Get("xq")
			}
		}
		if courseID == "" || classID == "" {
			continue
		}
		rows = append(rows, ScheduleRow{
			Sequence: values[0], Department: values[1], CourseName: values[2], ClassName: values[3],
			Teacher: values[4], Classroom: values[5], Weekday: values[6], Period: values[7],
			EnrolledText: values[8], CourseID: courseID, ClassID: classID, RawSemester: semester,
		})
	}
	if len(rows) == 0 {
		return nil, errors.New("Public_Kkap 解析到 0 行")
	}
	return rows, nil
}

func directCells(tr *xhtml.Node) []*xhtml.Node {
	var cells []*xhtml.Node
	for node := tr.FirstChild; node != nil; node = node.NextSibling {
		if node.Type == xhtml.ElementNode && (strings.EqualFold(node.Data, "td") || strings.EqualFold(node.Data, "th")) {
			cells = append(cells, node)
		}
	}
	return cells
}

func htmlURL(raw string) *url.URL {
	parsed, err := url.Parse(strings.ReplaceAll(raw, "&amp;", "&"))
	if err != nil {
		return nil
	}
	return parsed
}

func encodeResponse(value any) encodedResponse {
	raw, _ := json.Marshal(value)
	var compressed strings.Builder
	zw, _ := gzip.NewWriterLevel(&compressed, 5)
	_, _ = zw.Write(raw)
	_ = zw.Close()
	sum := sha256.Sum256(raw)
	return encodedResponse{raw: raw, gzip: []byte(compressed.String()), etag: `"` + hex.EncodeToString(sum[:12]) + `"`}
}
