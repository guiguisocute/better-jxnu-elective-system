package app

import (
	"encoding/json"
	"testing"
)

func TestBuildStudentRecordSelectedTerm(t *testing.T) {
	ctx := &MasterContext{CreditOf: map[string]any{"A": json.Number("2"), "028021": json.Number("1")}, EnglishFeatureIDs: map[string]bool{}, ValidPlanKeys: map[string]bool{"2025级-计算机科学与技术（综合型）": true}, PlanCourses: map[string][]planCourse{"2025级-计算机科学与技术（综合型）": {{CID: "A", Name: "高数", Nature: "专业类基础", Semester: "第1学期", Credits: json.Number("2")}, {CID: "028021", Name: "红色文化", Nature: "公共必修课", Semester: "第1学期", Credits: json.Number("1")}}}}
	agg := StudentAggregate{ClassName: "25级计算机科学与技术1班", PlanningTerm: "26-27第1学期", Courses: []DetailCourse{{CourseNo: "A", CourseName: "高数", Semester: "25-26第1学期"}}, ScheduleItems: []ScheduleItem{{CourseName: "高数", CourseNo: "A", DayOfWeek: 1, DayLabel: "星期一", StartPeriod: 1, EndPeriod: 2}}, NoSchedule: false}
	built := BuildStudentRecord("202500000001", agg, ctx, "")
	if built.PlanKey != "2025级-计算机科学与技术（综合型）" {
		t.Fatalf("plan match=%q", built.PlanKey)
	}
	if built.Row["total_earned"] != float64(3) {
		t.Fatalf("earned=%v", built.Row["total_earned"])
	}
	if built.Record["planningSemester"] != "2026-09" {
		t.Fatalf("planning=%v", built.Record["planningSemester"])
	}
	if built.Record["readingPlanTerm"] != 2 {
		t.Fatalf("reading term=%v", built.Record["readingPlanTerm"])
	}
}

// A finished semester's credits must count as 已修 once the operator declares
// that term finalized. This is the 999999999999 case: 教务 had already moved its
// selected term to 26-27第1学期, so 25-26第2学期 looked "在读" and its credits were
// withheld (87 instead of 109) even though the semester was over and graded.
func TestBuildStudentRecordFinalizedTermCountsFinishedSemester(t *testing.T) {
	ctx := &MasterContext{
		CreditOf:          map[string]any{"T1": json.Number("3"), "T2": json.Number("4"), "T3": json.Number("5")},
		EnglishFeatureIDs: map[string]bool{},
		ValidPlanKeys:     map[string]bool{"2025级-计算机科学与技术（综合型）": true},
		PlanCourses:       map[string][]planCourse{"2025级-计算机科学与技术（综合型）": {}},
	}
	// 2025 cohort, 教务 planning term = 26-27第1学期 → plan term 3.
	// Reading term is therefore 25-26第2学期 = plan term 2.
	agg := StudentAggregate{
		ClassName:    "25级计算机科学与技术1班",
		PlanningTerm: "26-27第1学期",
		Courses: []DetailCourse{
			{CourseNo: "T1", CourseName: "学期一", Semester: "25-26第1学期"}, // plan term 1
			{CourseNo: "T2", CourseName: "学期二", Semester: "25-26第2学期"}, // plan term 2 = 在读
			{CourseNo: "T3", CourseName: "学期三", Semester: "26-27第1学期"}, // plan term 3 = 未来
		},
	}

	// 未设置：沿用旧口径，整个在读学期不算 → 只有 T1。
	if got := BuildStudentRecord("202500000001", agg, ctx, "").Row["total_earned"]; got != float64(3) {
		t.Fatalf("without a finalized term, earned = %v, want 3", got)
	}
	// 声明 25-26第2学期 已结束 → T1+T2 计入，未来学期仍不算。
	if got := BuildStudentRecord("202500000001", agg, ctx, "25-26第2学期").Row["total_earned"]; got != float64(7) {
		t.Fatalf("with 25-26第2学期 finalized, earned = %v, want 7 (T1+T2, never the future term)", got)
	}
	// 往回设一个更早的学期不该倒扣已修学分。
	if got := BuildStudentRecord("202500000001", agg, ctx, "24-25第1学期").Row["total_earned"]; got != float64(3) {
		t.Fatalf("an older finalized term must not reduce earned credits, got %v", got)
	}
	// 乱填的学期忽略掉，退回旧口径而不是崩掉或清零。
	if got := BuildStudentRecord("202500000001", agg, ctx, "垃圾数据").Row["total_earned"]; got != float64(3) {
		t.Fatalf("an unparseable finalized term must fall back to the old rule, got %v", got)
	}
}

func TestParseChangeClass(t *testing.T) {
	raw := `<table><tr><td>序号</td></tr><tr><td>1</td><td>合班.1班</td><td>张三</td><td>专业</td><td>31</td><td>0</td><td>班级容量已满</td><td><a href="x?bjh=B01">操作</a></td></tr></table>`
	got := ParseChangeClass(raw, "C01")
	if len(got.Classes) != 1 {
		t.Fatalf("classes=%#v", got.Classes)
	}
	if got.Classes[0].Enrolled == nil || *got.Classes[0].Enrolled != 31 || !got.Classes[0].Full {
		t.Fatalf("class=%#v", got.Classes[0])
	}
}
