package app

import (
	"io"
	"log/slog"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestEnrollmentServiceLoadsRecentMatchingSnapshot(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenConfigStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := EnrollmentSnapshot{
		Version: 1, Semester: store.Get().LiveEnrollmentTarget(),
		FetchedAt: time.Now().UTC().Format(time.RFC3339), SourceRows: 2,
		ClassCount: 1, Items: []EnrollmentItem{{"课程", "班级", "教师", 3}},
	}
	if err := WriteJSON(filepath.Join(dir, "enrollment_snapshot.json"), snapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service := NewEnrollmentService(store, logger)
	_, _, ok := service.Responses()
	if !ok {
		t.Fatal("recent matching snapshot was not loaded")
	}
	if got := service.Status().Snapshot; got == nil || got.ClassCount != 1 {
		t.Fatalf("loaded snapshot = %#v", got)
	}
}

func TestParseSchoolTermOptions(t *testing.T) {
	doc, err := parseHTML(`<select name="ddlSterm"><option value="2026/9/1 0:00:00">26-27第1学期</option><option value="2027/3/1 0:00:00">26-27第2学期</option></select>`)
	if err != nil {
		t.Fatal(err)
	}
	got := parseSchoolTermOptions(doc)
	want := []SchoolTermOption{
		{Label: "26-27第1学期", Value: "2026/9/1 0:00:00", Semester: "2026-09"},
		{Label: "26-27第2学期", Value: "2027/3/1 0:00:00", Semester: "2027-03"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("options = %#v", got)
	}
}

func TestValidateScheduleSemester(t *testing.T) {
	rows := []ScheduleRow{{RawSemester: "2027/3/1 0:00:00"}, {RawSemester: "2027/3/1 0:00:00"}}
	if err := validateScheduleSemester(rows, "2027-03"); err != nil {
		t.Fatal(err)
	}
	rows[1].RawSemester = "2026/9/1 0:00:00"
	if err := validateScheduleSemester(rows, "2027-03"); err == nil {
		t.Fatal("mixed-semester response accepted")
	}
}

func TestFormalScheduleFingerprintIgnoresEnrollmentAndOrder(t *testing.T) {
	a := []ScheduleRow{
		{CourseID: "2", ClassID: "b", Teacher: "乙", RawSemester: "2027/3/1 0:00:00", EnrolledText: "10", Sequence: "1"},
		{CourseID: "1", ClassID: "a", Teacher: "甲", RawSemester: "2027/3/1 0:00:00", EnrolledText: "20", Sequence: "2"},
	}
	b := []ScheduleRow{
		{CourseID: "1", ClassID: "a", Teacher: "甲", RawSemester: "2027/3/1 0:00:00", EnrolledText: "99", Sequence: "1"},
		{CourseID: "2", ClassID: "b", Teacher: "乙", RawSemester: "2027/3/1 0:00:00", EnrolledText: "88", Sequence: "2"},
	}
	if formalScheduleFingerprint(a) != formalScheduleFingerprint(b) {
		t.Fatal("non-structural changes altered the fingerprint")
	}
}

func TestEnrollmentServiceRejectsOtherSemesterSnapshot(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenConfigStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := EnrollmentSnapshot{Version: 1, Semester: "2025-09", FetchedAt: time.Now().UTC().Format(time.RFC3339), ClassCount: 1, Items: []EnrollmentItem{{"课程", "班级", "教师", 3}}}
	if err := WriteJSON(filepath.Join(dir, "enrollment_snapshot.json"), snapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	service := NewEnrollmentService(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, _, ok := service.Responses(); ok {
		t.Fatal("snapshot from another semester was loaded")
	}
}
