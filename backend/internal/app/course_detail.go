package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	xhtml "golang.org/x/net/html"
)

var (
	courseIDPattern = regexp.MustCompile(`^[0-9A-Za-z]{4,12}$`)
	classIDPattern  = regexp.MustCompile(`^[0-9A-Za-z$._-]{1,40}$`)
)

type CourseSettingLink struct {
	Text string `json:"text"`
	URL  string `json:"url"`
}

type CourseInfoElement struct {
	Tag  string `json:"tag"`
	ID   string `json:"id"`
	Text string `json:"text"`
}

type CourseSettingInspection struct {
	CourseID string              `json:"courseId"`
	ClassID  string              `json:"classId"`
	FinalURL string              `json:"finalUrl"`
	Title    string              `json:"title"`
	Links    []CourseSettingLink `json:"links"`
	InfoURL  string              `json:"infoUrl,omitempty"`
	InfoRows [][]string          `json:"infoRows,omitempty"`
	InfoIDs  []CourseInfoElement `json:"infoIds,omitempty"`
	Metadata *CourseDetailRecord `json:"metadata,omitempty"`
}

type CourseDetailRecord struct {
	CourseID           string  `json:"courseId"`
	CourseName         string  `json:"courseName"`
	CourseNameIdentity string  `json:"courseNameIdentity,omitempty"`
	EnglishName        string  `json:"englishName,omitempty"`
	Credits            float64 `json:"credits"`
	Description        string  `json:"description,omitempty"`
	ClassID            string  `json:"classId"`
	CourseSiteID       string  `json:"courseSiteId,omitempty"`
	Semester           string  `json:"semester"`
	SourceURL          string  `json:"sourceUrl"`
	FetchedAt          string  `json:"fetchedAt"`
}

type CourseDetailSnapshot struct {
	Version   int                  `json:"version"`
	Semester  string               `json:"semester"`
	FetchedAt string               `json:"fetchedAt"`
	Courses   []CourseDetailRecord `json:"courses"`
}

type CourseDetailRefreshStats struct {
	Candidates int `json:"candidates"`
	Attempted  int `json:"attempted"`
	Updated    int `json:"updated"`
	Refreshed  int `json:"refreshed"`
	Unchanged  int `json:"unchanged"`
	Failed     int `json:"failed"`
	Cached     int `json:"cached"`
}

// InspectCourseSetting is also a useful production diagnostic when JWC changes
// the CourseSetting page. It returns only same-origin link text/URLs, never
// cookies or page HTML.
func (c *JWCClient) InspectCourseSetting(ctx context.Context, classID, courseID, semester string) (CourseSettingInspection, error) {
	if !classIDPattern.MatchString(classID) || !courseIDPattern.MatchString(courseID) {
		return CourseSettingInspection{}, errors.New("课程号或班级号格式不合法")
	}
	if strings.TrimSpace(semester) == "" {
		return CourseSettingInspection{}, errors.New("学期不能为空")
	}
	if !c.IsAuthed() {
		if err := c.Login(ctx); err != nil {
			return CourseSettingInspection{}, err
		}
	}
	query := url.Values{"bjh": {classID}, "kch": {courseID}, "xq": {semester}}
	target := jwcBase + "/wsktNew/CourseSetting.aspx?" + query.Encode()
	result, body, err := c.do(ctx, http.MethodGet, target, nil, http.Header{"Referer": {jwcBase + "/Portal/Index.aspx"}})
	if err != nil {
		return CourseSettingInspection{}, err
	}
	if looksLoggedOut(body) {
		c.resetSession()
		if err := c.Login(ctx); err != nil {
			return CourseSettingInspection{}, err
		}
		result, body, err = c.do(ctx, http.MethodGet, target, nil, http.Header{"Referer": {jwcBase + "/Portal/Index.aspx"}})
		if err != nil {
			return CourseSettingInspection{}, err
		}
	}
	doc, err := parseHTML(body)
	if err != nil {
		return CourseSettingInspection{}, err
	}
	inspection := CourseSettingInspection{CourseID: courseID, ClassID: classID, FinalURL: result.finalURL}
	if title := findFirst(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "title")
	}); title != nil {
		inspection.Title = nodeText(title)
	}
	base, _ := url.Parse(result.finalURL)
	seen := map[string]bool{}
	for _, anchor := range findAll(doc, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "a")
	}) {
		href := strings.TrimSpace(attr(anchor, "href"))
		if href == "" || strings.HasPrefix(strings.ToLower(href), "javascript:") {
			continue
		}
		parsed, parseErr := url.Parse(href)
		if parseErr != nil {
			continue
		}
		resolved := base.ResolveReference(parsed)
		if !strings.EqualFold(resolved.Host, "jwc.jxnu.edu.cn") || resolved.Scheme != "https" {
			continue
		}
		key := nodeText(anchor) + "\x00" + resolved.String()
		if seen[key] {
			continue
		}
		seen[key] = true
		inspection.Links = append(inspection.Links, CourseSettingLink{Text: nodeText(anchor), URL: resolved.String()})
		if inspection.InfoURL == "" && strings.Contains(nodeText(anchor), "课程简介") {
			inspection.InfoURL = resolved.String()
		}
	}
	if inspection.InfoURL != "" {
		_, infoBody, infoErr := c.do(ctx, http.MethodGet, inspection.InfoURL, nil, http.Header{"Referer": {result.finalURL}})
		if infoErr != nil {
			return CourseSettingInspection{}, infoErr
		}
		infoDoc, parseErr := parseHTML(infoBody)
		if parseErr != nil {
			return CourseSettingInspection{}, parseErr
		}
		for _, row := range findAll(infoDoc, func(n *xhtml.Node) bool {
			return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "tr")
		}) {
			var cells []string
			for child := row.FirstChild; child != nil; child = child.NextSibling {
				if child.Type == xhtml.ElementNode && (strings.EqualFold(child.Data, "td") || strings.EqualFold(child.Data, "th")) {
					if text := nodeText(child); text != "" {
						cells = append(cells, text)
					}
				}
			}
			joined := strings.Join(cells, " ")
			if len(cells) >= 2 && len(joined) <= 2000 && !strings.Contains(joined, "学号") && !strings.Contains(joined, "欢迎") {
				inspection.InfoRows = append(inspection.InfoRows, cells)
			}
		}
		for _, element := range findAll(infoDoc, func(n *xhtml.Node) bool {
			return n.Type == xhtml.ElementNode && attr(n, "id") != ""
		}) {
			text := nodeText(element)
			if text == "" || len(text) > 4000 || strings.Contains(text, "学号") || strings.Contains(text, "欢迎") {
				continue
			}
			inspection.InfoIDs = append(inspection.InfoIDs, CourseInfoElement{Tag: element.Data, ID: attr(element, "id"), Text: text})
		}
		metadata := parseCourseDetailRows(inspection.InfoRows)
		metadata.CourseID = firstNonEmpty(metadata.CourseID, courseID)
		metadata.ClassID = classID
		metadata.Semester = semester
		metadata.SourceURL = inspection.InfoURL
		metadata.FetchedAt = time.Now().UTC().Format(time.RFC3339)
		if final, parseErr := url.Parse(result.finalURL); parseErr == nil {
			metadata.CourseSiteID = final.Query().Get("CourseID")
		}
		inspection.Metadata = &metadata
	}
	return inspection, nil
}

func (c *JWCClient) FetchCourseDetail(ctx context.Context, classID, courseID, semester string) (CourseDetailRecord, error) {
	inspection, err := c.InspectCourseSetting(ctx, classID, courseID, semester)
	if err != nil {
		return CourseDetailRecord{}, err
	}
	if inspection.Metadata == nil {
		return CourseDetailRecord{}, errors.New("课程设置页没有课程简介入口")
	}
	metadata := *inspection.Metadata
	if metadata.CourseID != courseID {
		return CourseDetailRecord{}, fmt.Errorf("课程简介返回课程号 %q，与请求 %q 不一致", metadata.CourseID, courseID)
	}
	if metadata.CourseName == "" && metadata.Credits <= 0 && metadata.Description == "" {
		return CourseDetailRecord{}, errors.New("课程简介页面没有可用字段")
	}
	return metadata, nil
}

func parseCourseDetailRows(rows [][]string) CourseDetailRecord {
	metadata := CourseDetailRecord{}
	for _, row := range rows {
		for index := 0; index+1 < len(row); index += 2 {
			label := normalizeCourseField(row[index])
			value := strings.TrimSpace(row[index+1])
			switch label {
			case "课程名称":
				metadata.CourseName = value
			case "课程名称标识":
				metadata.CourseNameIdentity = value
			case "课程英文名称", "英文名称":
				metadata.EnglishName = value
			case "课程号":
				metadata.CourseID = value
			case "学分":
				metadata.Credits, _ = strconv.ParseFloat(value, 64)
			case "内容简介", "课程简介":
				metadata.Description = value
			}
		}
	}
	return metadata
}

func normalizeCourseField(value string) string {
	value = strings.NewReplacer("：", "", ":", "", " ", "", "\u00a0", "").Replace(value)
	return strings.TrimSpace(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func semesterCourseSettingValue(semester string) (string, error) {
	if !semesterPattern.MatchString(semester) {
		return "", errors.New("课程详情学期必须是 YYYY-03 或 YYYY-09")
	}
	year := semester[:4]
	month := "9"
	if strings.HasSuffix(semester, "-03") {
		month = "3"
	}
	return year + "/" + month + "/1 0:00:00", nil
}

func RefreshCourseDetails(ctx context.Context, client *JWCClient, semester string, rows []ScheduleRow, old CourseDetailSnapshot, cfg RuntimeConfig, logger *slog.Logger) (CourseDetailSnapshot, CourseDetailRefreshStats) {
	stats := CourseDetailRefreshStats{}
	byID := make(map[string]CourseDetailRecord, len(old.Courses))
	for _, record := range old.Courses {
		if courseIDPattern.MatchString(record.CourseID) {
			byID[record.CourseID] = record
		}
	}
	classByCourse := map[string]string{}
	missingInfo := map[string]bool{}
	for _, row := range rows {
		if !courseIDPattern.MatchString(row.CourseID) || !classIDPattern.MatchString(row.ClassID) {
			continue
		}
		if _, exists := classByCourse[row.CourseID]; !exists {
			classByCourse[row.CourseID] = row.ClassID
		}
		courseInfo, ok := row.CourseInfo.(map[string]any)
		if !ok || strings.TrimSpace(fmt.Sprint(courseInfo["学分"])) == "" || fmt.Sprint(courseInfo["学分"]) == "0" {
			missingInfo[row.CourseID] = true
		}
	}
	tracked := map[string]bool{}
	priority := map[string]bool{}
	var targets []string
	addTarget := func(courseID string) {
		if tracked[courseID] || classByCourse[courseID] == "" {
			return
		}
		tracked[courseID] = true
		targets = append(targets, courseID)
	}
	for _, courseID := range cfg.CourseDetailCourseIDs {
		priority[courseID] = true
		record, cached := byID[courseID]
		if cfg.CourseDetailsVerifyTrackedEveryRun || !cached || courseDetailExpired(record, cfg.CourseDetailsRefreshHours, time.Now()) {
			addTarget(courseID)
		}
	}
	var autoIDs []string
	for courseID := range missingInfo {
		record, cached := byID[courseID]
		if !cached || courseDetailExpired(record, cfg.CourseDetailsRefreshHours, time.Now()) {
			autoIDs = append(autoIDs, courseID)
		}
	}
	sort.Strings(autoIDs)
	for _, courseID := range autoIDs {
		if len(targets) >= cfg.CourseDetailsMaxPerRun {
			break
		}
		addTarget(courseID)
	}
	if len(targets) > cfg.CourseDetailsMaxPerRun {
		targets = targets[:cfg.CourseDetailsMaxPerRun]
	}
	stats.Candidates = len(targets)
	settingSemester, err := semesterCourseSettingValue(semester)
	if err != nil {
		logger.Warn("课程详情学期无效", "error", err)
		return old, stats
	}
	for index, courseID := range targets {
		if index > 0 {
			select {
			case <-ctx.Done():
				return courseDetailSnapshot(semester, byID), stats
			case <-time.After(time.Duration(cfg.CourseDetailsDelayMilliseconds) * time.Millisecond):
			}
		}
		stats.Attempted++
		record, fetchErr := client.FetchCourseDetail(ctx, classByCourse[courseID], courseID, settingSemester)
		if fetchErr != nil {
			stats.Failed++
			logger.Warn("课程详情核查失败", "courseId", courseID, "error", fetchErr)
			continue
		}
		if previous, exists := byID[courseID]; exists && sameCourseDetail(previous, record) {
			stats.Unchanged++
			if !priority[courseID] || !cfg.CourseDetailsVerifyTrackedEveryRun {
				previous.FetchedAt = record.FetchedAt
				byID[courseID] = previous
				stats.Refreshed++
			}
			continue
		}
		byID[courseID] = record
		stats.Updated++
	}
	stats.Cached = len(byID)
	return courseDetailSnapshot(semester, byID), stats
}

func sameCourseDetail(left, right CourseDetailRecord) bool {
	return left.CourseID == right.CourseID && left.CourseName == right.CourseName &&
		left.CourseNameIdentity == right.CourseNameIdentity && left.EnglishName == right.EnglishName &&
		left.Credits == right.Credits && left.Description == right.Description &&
		left.ClassID == right.ClassID && left.CourseSiteID == right.CourseSiteID &&
		left.Semester == right.Semester && left.SourceURL == right.SourceURL
}

func courseDetailExpired(record CourseDetailRecord, refreshHours int, now time.Time) bool {
	fetchedAt, err := time.Parse(time.RFC3339, record.FetchedAt)
	return err != nil || now.Sub(fetchedAt) >= time.Duration(refreshHours)*time.Hour
}

func courseDetailSnapshot(semester string, records map[string]CourseDetailRecord) CourseDetailSnapshot {
	items := make([]CourseDetailRecord, 0, len(records))
	for _, record := range records {
		items = append(items, record)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CourseID < items[j].CourseID })
	return CourseDetailSnapshot{Version: 1, Semester: semester, FetchedAt: time.Now().UTC().Format(time.RFC3339), Courses: items}
}
