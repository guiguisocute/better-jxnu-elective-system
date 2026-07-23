package app

import (
	"testing"
	"time"
)

func TestParseCourseDetailRows(t *testing.T) {
	got := parseCourseDetailRows([][]string{
		{"课 程 名 称 ：", "大数据和人工智能（2分）", "课程名称标识：", "大数据和人工智能（2分）"},
		{"课 程 号 ：", "259772", "学 分 ：", "2"},
		{"课程英文名称：", "AI and Big Data", "内容简介：", "课程介绍"},
	})
	if got.CourseID != "259772" || got.CourseName != "大数据和人工智能（2分）" || got.Credits != 2 || got.EnglishName != "AI and Big Data" || got.Description != "课程介绍" {
		t.Fatalf("unexpected metadata: %#v", got)
	}
}

func TestSemesterCourseSettingValue(t *testing.T) {
	for input, want := range map[string]string{"2026-09": "2026/9/1 0:00:00", "2027-03": "2027/3/1 0:00:00"} {
		got, err := semesterCourseSettingValue(input)
		if err != nil || got != want {
			t.Fatalf("%s => %q, %v; want %q", input, got, err, want)
		}
	}
}

func TestSameCourseDetailIgnoresFetchedAt(t *testing.T) {
	left := CourseDetailRecord{CourseID: "259772", CourseName: "课程", Credits: 2, FetchedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)}
	right := left
	right.FetchedAt = time.Now().Format(time.RFC3339)
	if !sameCourseDetail(left, right) {
		t.Fatal("FetchedAt alone should not create repository churn")
	}
	right.Credits = 3
	if sameCourseDetail(left, right) {
		t.Fatal("metadata change must be detected")
	}
}
