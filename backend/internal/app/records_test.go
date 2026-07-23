package app

import (
	"encoding/json"
	"testing"
)

func TestBuildStudentRecordSelectedTerm(t *testing.T) {
	ctx := &MasterContext{CreditOf: map[string]any{"A": json.Number("2"), "028021": json.Number("1")}, EnglishFeatureIDs: map[string]bool{}, ValidPlanKeys: map[string]bool{"2025级-计算机科学与技术（综合型）": true}, PlanCourses: map[string][]planCourse{"2025级-计算机科学与技术（综合型）": {{CID: "A", Name: "高数", Nature: "专业类基础", Semester: "第1学期", Credits: json.Number("2")}, {CID: "028021", Name: "红色文化", Nature: "公共必修课", Semester: "第1学期", Credits: json.Number("1")}}}}
	agg := StudentAggregate{ClassName: "25级计算机科学与技术1班", PlanningTerm: "26-27第1学期", Courses: []DetailCourse{{CourseNo: "A", CourseName: "高数", Semester: "25-26第1学期"}}, ScheduleItems: []ScheduleItem{{CourseName: "高数", CourseNo: "A", DayOfWeek: 1, DayLabel: "星期一", StartPeriod: 1, EndPeriod: 2}}, NoSchedule: false}
	built := BuildStudentRecord("202500000001", agg, ctx)
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
