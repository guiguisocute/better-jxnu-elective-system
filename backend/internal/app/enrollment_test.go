package app

import (
	"io"
	"log/slog"
	"path/filepath"
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
		Version: 1, Semester: store.Get().LiveEnrollmentSemester,
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
