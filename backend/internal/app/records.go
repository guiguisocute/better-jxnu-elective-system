package app

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var (
	requiredNatures   = map[string]bool{"公共必修课": true, "专业主干": true, "专业类基础": true, "教师教育必修": true}
	specialCreditIDs  = map[string]bool{"028021": true, "028022": true, "028023": true, "028020": true, "024001": true}
	shifanHints       = []string{"公费师范生", "国家公费师范生", "公费师范", "师范"}
	nonShifanDefaults = []string{"综合型", "学术型", "普通", "非师范"}
)

type masterCourse struct {
	ID      string   `json:"id"`
	Credits any      `json:"credits"`
	Tags    []string `json:"tags"`
}
type planCourse struct {
	CID      string `json:"cid"`
	Name     string `json:"name"`
	Nature   string `json:"nature"`
	Credits  any    `json:"credits"`
	Semester string `json:"semester"`
}
type majorRequirement struct {
	Year  string `json:"year"`
	Major string `json:"major"`
}

type MasterContext struct {
	CreditOf          map[string]any
	EnglishFeatureIDs map[string]bool
	ValidPlanKeys     map[string]bool
	PlanCourses       map[string][]planCourse
}

func LoadMasterContext(masterDir string) (*MasterContext, error) {
	var courses []masterCourse
	if err := readJSONFile(filepath.Join(masterDir, "courses.json"), &courses); err != nil {
		return nil, err
	}
	var plans map[string][]planCourse
	if err := readJSONFile(filepath.Join(masterDir, "plan_courses.json"), &plans); err != nil {
		return nil, err
	}
	var requirements []majorRequirement
	if err := readJSONFile(filepath.Join(masterDir, "major_requirements.json"), &requirements); err != nil {
		return nil, err
	}
	ctx := &MasterContext{CreditOf: map[string]any{}, EnglishFeatureIDs: map[string]bool{}, ValidPlanKeys: map[string]bool{}, PlanCourses: plans}
	for _, course := range courses {
		if course.ID == "" {
			continue
		}
		ctx.CreditOf[course.ID] = course.Credits
		for _, tag := range course.Tags {
			if tag == "大学英语特色课" {
				ctx.EnglishFeatureIDs[course.ID] = true
			}
		}
	}
	for key := range plans {
		ctx.ValidPlanKeys[key] = true
	}
	for _, req := range requirements {
		if req.Year != "" && req.Major != "" {
			ctx.ValidPlanKeys[req.Year+"级-"+req.Major] = true
		}
	}
	return ctx, nil
}

func readJSONFile(path string, target any) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("打开 %s: %w", path, err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("解析 %s: %w", path, err)
	}
	return nil
}

type BuiltStudentRecord struct {
	Row            map[string]any
	Record         map[string]any
	PlanKey        string
	MissingCredits []string
}

// BuildStudentRecord derives one student's record from a live 教务 fetch.
//
// finalizedTerm ("25-26第2学期" style, empty = 未设置) is the newest academic term
// whose grades are final. It exists because "已修学分（不含本学期）" has to know
// which semester is still in progress, and 教务 cannot tell us: it switches its
// selected term to the *next* one as soon as 选课 opens, so between semesters the
// model would treat an already-finished term as "在读" and withhold its credits.
// For 999999999999 in July 2026 that hid 22 earned credits (87 instead of 109).
//
// The operator sets it in 日常设置, and 固化学期 sets it automatically — declaring
// a semester finalized is exactly the same act as freezing its timetable.
func BuildStudentRecord(sid string, aggregate StudentAggregate, ctx *MasterContext, finalizedTerm string) BuiltStudentRecord {
	planKey := classNameToPlanKey(aggregate.ClassName, ctx.ValidPlanKeys)
	enrollYear := enrollYearOf(planKey, aggregate.ClassName)
	planningCal, _ := parseStudentSemester(aggregate.PlanningTerm)
	planningSemester := calendarTermKey(planningCal)
	readingPlanTerm := planTermFromCalendar(enrollYear, previousCalendarTerm(planningCal))
	// earnedThroughTerm is the last plan term that counts as 已修. Without an
	// explicit finalized term this stays readingPlanTerm-1, i.e. the original
	// "exclude the whole reading semester" behaviour.
	earnedThroughTerm := readingPlanTerm - 1
	if finalCal, ok := parseStudentSemester(finalizedTerm); ok {
		if final := planTermFromCalendar(enrollYear, finalCal); final > earnedThroughTerm {
			earnedThroughTerm = final
		}
	}
	planCourses := ctx.PlanCourses[planKey]
	natureOf := map[string]string{}
	var requiredUpToReading []string
	for _, course := range planCourses {
		natureOf[course.CID] = course.Nature
		if readingPlanTerm > 0 && requiredNatures[course.Nature] {
			if term := chineseTermIndex(course.Semester); term > 0 && term <= readingPlanTerm {
				requiredUpToReading = append(requiredUpToReading, course.CID)
			}
		}
	}
	missing := map[string]bool{}
	seen := map[string]bool{}
	var details []map[string]any
	totalEarned := 0.0
	for _, course := range aggregate.Courses {
		seen[course.CourseNo] = true
		credits, ok := ctx.CreditOf[course.CourseNo]
		if !ok {
			missing[course.CourseNo] = true
			credits = json.Number("0")
		}
		termCal, _ := parseStudentSemester(course.Semester)
		planTermIndex := planTermFromCalendar(enrollYear, termCal)
		nature := natureOf[course.CourseNo]
		if nature == "" && ctx.EnglishFeatureIDs[course.CourseNo] {
			nature = "大学英语特色课"
		}
		details = append(details, map[string]any{
			"courseId": course.CourseNo, "courseName": course.CourseName, "credits": credits,
			"semester": nullableString(course.Semester), "planTermIndex": planTermIndex,
			"nature": nullableString(nature), "teacher": nullableString(course.Teacher), "teachingClass": nullableString(course.TeachingClass),
		})
		if readingPlanTerm <= 0 || planTermIndex == 0 || planTermIndex <= earnedThroughTerm {
			totalEarned += numberValue(credits)
		}
	}
	if readingPlanTerm > 0 {
		for _, course := range planCourses {
			if !specialCreditIDs[course.CID] || seen[course.CID] {
				continue
			}
			term := chineseTermIndex(course.Semester)
			if term <= 0 || term > readingPlanTerm {
				continue
			}
			credits, ok := ctx.CreditOf[course.CID]
			if !ok || credits == nil {
				credits = course.Credits
			}
			details = append(details, map[string]any{
				"courseId": course.CID, "courseName": course.Name, "credits": credits, "semester": nil,
				"planTermIndex": term, "nature": course.Nature, "teacher": nil, "teachingClass": nil, "supplemented": true,
			})
			totalEarned += numberValue(credits)
		}
	}
	var schedule []map[string]any
	for _, item := range aggregate.ScheduleItems {
		var credits any
		if value, ok := ctx.CreditOf[item.CourseNo]; ok {
			credits = value
		}
		schedule = append(schedule, map[string]any{
			"courseId": item.CourseNo, "courseName": strings.TrimSpace(item.CourseName), "teacher": nullableString(item.Teacher),
			"className": nullableString(item.TeachingClass), "classroom": nullableString(item.Location), "schedule": nullableString(formatSchedule(item)),
			"credits": credits, "dayOfWeek": item.DayOfWeek, "startPeriod": item.StartPeriod, "endPeriod": item.EndPeriod,
		})
	}
	record := map[string]any{
		"studentId": sid, "className": nullableString(aggregate.ClassName), "termLabel": nullableString(aggregate.PlanningTerm),
		"planningSemester": nullableString(planningSemester), "noSchedule": aggregate.NoSchedule,
		"readingPlanTerm": nullableInt(readingPlanTerm), "requiredCidsUpToReading": requiredUpToReading,
		"scheduleItems": schedule, "detailCourses": details,
	}
	planValue := any(nil)
	if planKey != "" {
		planValue = planKey
	}
	row := map[string]any{"student_id": sid, "class_name": aggregate.ClassName, "plan_key": planValue,
		"total_earned": math.Round(totalEarned*100) / 100, "taken_count": len(details)}
	missingList := make([]string, 0, len(missing))
	for cid := range missing {
		missingList = append(missingList, cid)
	}
	sort.Strings(missingList)
	return BuiltStudentRecord{Row: row, Record: record, PlanKey: planKey, MissingCredits: missingList}
}

func classNameToPlanKey(className string, valid map[string]bool) string {
	parsed, ok := parseClassName(className)
	if !ok {
		return ""
	}
	year, body, middle, tail := parsed.year, parsed.body, parsed.middle, parsed.tail
	prefix := strconv.Itoa(year) + "级-"
	var candidates []string
	add := func(major string) {
		key := prefix + major
		if major != "" && valid[key] {
			for _, value := range candidates {
				if value == key {
					return
				}
			}
			candidates = append(candidates, key)
		}
	}
	add(body)
	if middle != "" {
		add(body + "（" + middle + "）")
	}
	if tail != "" {
		add(body + "（" + tail + "）")
	}
	shifan := containsAny(middle+tail, shifanHints)
	if shifan {
		for _, hint := range shifanHints {
			add(body + "（" + hint + "）")
		}
	}
	for _, hint := range nonShifanDefaults {
		add(body + "（" + hint + "）")
	}
	if !shifan {
		for _, hint := range shifanHints {
			add(body + "（" + hint + "）")
		}
	}
	if len(candidates) > 0 {
		return candidates[0]
	}
	return ""
}

type parsedClassName struct {
	year               int
	body, middle, tail string
}

func parseClassName(className string) (parsedClassName, bool) {
	value := strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(className), "(", "（"), ")", "）")
	head := regexp.MustCompile(`^(\d{2})级`).FindStringSubmatchIndex(value)
	if len(head) == 0 {
		return parsedClassName{}, false
	}
	year, _ := strconv.Atoi(value[head[2]:head[3]])
	rest := value[head[1]:]
	tailRe := regexp.MustCompile(`(\d+)?班\s*(?:（([^）]*)）)?\s*$`)
	tailMatch := tailRe.FindStringSubmatchIndex(rest)
	if len(tailMatch) == 0 {
		return parsedClassName{}, false
	}
	tail := ""
	if tailMatch[4] >= 0 {
		tail = rest[tailMatch[4]:tailMatch[5]]
	}
	bodyFull := strings.TrimSpace(rest[:tailMatch[0]])
	middle := ""
	middleRe := regexp.MustCompile(`（([^）]*)）`)
	middleMatch := middleRe.FindStringSubmatch(bodyFull)
	if len(middleMatch) > 1 {
		middle = middleMatch[1]
	}
	body := strings.TrimSpace(middleRe.ReplaceAllString(bodyFull, ""))
	return parsedClassName{2000 + year, body, middle, tail}, true
}

func containsAny(value string, needles []string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

type calendarTerm struct {
	year   int
	autumn bool
	valid  bool
}

func enrollYearOf(planKey, className string) int {
	if match := regexp.MustCompile(`(\d{4})`).FindStringSubmatch(planKey); len(match) > 1 {
		year, _ := strconv.Atoi(match[1])
		return year
	}
	if match := regexp.MustCompile(`^\s*(\d{2})`).FindStringSubmatch(className); len(match) > 1 {
		year, _ := strconv.Atoi(match[1])
		return 2000 + year
	}
	return 0
}
func parseStudentSemester(label string) (calendarTerm, bool) {
	match := regexp.MustCompile(`(\d{2})-(\d{2})第(\d+)学期`).FindStringSubmatch(label)
	if len(match) == 0 {
		return calendarTerm{}, false
	}
	first, _ := strconv.Atoi(match[1])
	second, _ := strconv.Atoi(match[2])
	number, _ := strconv.Atoi(match[3])
	if number%2 == 1 {
		return calendarTerm{2000 + first, true, true}, true
	}
	return calendarTerm{2000 + second, false, true}, true
}
func planTermFromCalendar(enrollYear int, term calendarTerm) int {
	if enrollYear == 0 || !term.valid {
		return 0
	}
	n := 0
	if term.autumn {
		n = (term.year-enrollYear)*2 + 1
	} else {
		n = (term.year-1-enrollYear)*2 + 2
	}
	if n < 1 {
		return 1
	}
	return n
}
func previousCalendarTerm(term calendarTerm) calendarTerm {
	if !term.valid {
		return term
	}
	if term.autumn {
		return calendarTerm{term.year, false, true}
	}
	return calendarTerm{term.year - 1, true, true}
}
func calendarTermKey(term calendarTerm) string {
	if !term.valid {
		return ""
	}
	month := "03"
	if term.autumn {
		month = "09"
	}
	return fmt.Sprintf("%04d-%s", term.year, month)
}
func chineseTermIndex(label string) int {
	if match := regexp.MustCompile(`第\s*(\d+)\s*学期`).FindStringSubmatch(label); len(match) > 1 {
		n, _ := strconv.Atoi(match[1])
		return n
	}
	words := map[string]int{"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}
	if match := regexp.MustCompile(`第\s*([一二三四五六七八九十]+)\s*学期`).FindStringSubmatch(label); len(match) > 1 {
		return words[match[1]]
	}
	return 0
}
func formatSchedule(item ScheduleItem) string {
	period := formatPeriod(item.StartPeriod, item.EndPeriod)
	if item.DayLabel != "" && period != "" {
		return item.DayLabel + "-" + period
	}
	return item.DayLabel + period
}
func formatPeriod(start, end int) string {
	if start <= 0 {
		return ""
	}
	if end < start {
		start, end = end, start
	}
	if end == start {
		return fmt.Sprintf("第%d节", start)
	}
	var b strings.Builder
	b.WriteString("第")
	for n := start; n <= end; n++ {
		b.WriteString(strconv.Itoa(n))
	}
	b.WriteString("节")
	return b.String()
}
func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
func nullableInt(value int) any {
	if value == 0 {
		return nil
	}
	return value
}
func numberValue(value any) float64 {
	switch v := value.(type) {
	case json.Number:
		n, _ := v.Float64()
		return n
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case string:
		n, _ := strconv.ParseFloat(v, 64)
		return n
	}
	return 0
}
