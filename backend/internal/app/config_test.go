package app

import (
	"reflect"
	"testing"
	"time"
)

func TestRuntimeConfigValidation(t *testing.T) {
	cfg := DefaultRuntimeConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default config invalid: %v", err)
	}
	cfg.DefaultDataSource = "unknown"
	if err := cfg.Validate(); err == nil {
		t.Fatal("invalid data source accepted")
	}
	cfg = DefaultRuntimeConfig()
	cfg.StudentScheduleTerm = "26-27第10学期"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("two-digit term should be valid: %v", err)
	}
}

func TestAcademicTermMapping(t *testing.T) {
	cases := map[string]string{"2026-09": "26-27第1学期", "2027-03": "26-27第2学期"}
	for input, want := range cases {
		got, ok := AcademicTermFromSemester(input)
		if !ok || got != want {
			t.Errorf("%s => %q,%v want %q", input, got, ok, want)
		}
	}
	options := AcademicTermOptions([]string{"2026-09", "2027-03"}, "25-26第2学期", time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC))
	if !contains(options, "26-27第1学期") || !contains(options, "25-26第2学期") {
		t.Fatalf("missing generated terms: %v", options)
	}
}

func TestConfigStoreRoundTrip(t *testing.T) {
	path := t.TempDir() + "/config.json"
	store, err := OpenConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg := store.Get()
	cfg.DefaultDataSource = "addDrop"
	cfg.AllowedOrigins = []string{"https://example.test"}
	if err = store.Save(cfg); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg, reopened.Get()) {
		t.Fatalf("round trip mismatch\n%#v\n%#v", cfg, reopened.Get())
	}
}

func TestParseAutomationForm(t *testing.T) {
	cfg, err := ParseAutomationForm(map[string]string{
		"autoSyncEnabled": "on", "autoSyncIntervalMinutes": "120",
		"courseDetailsEnabled": "on", "courseDetailsVerifyTrackedEveryRun": "on",
		"courseDetailsRefreshHours": "72", "courseDetailsMaxPerRun": "40",
		"courseDetailsDelayMilliseconds": "500",
		"courseDetailCourseIDs":          "259772\n259773, 259772",
	}, DefaultRuntimeConfig())
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AutoSyncEnabled || cfg.AutoSyncIntervalMinutes != 120 || !cfg.CourseDetailsEnabled || !cfg.CourseDetailsVerifyTrackedEveryRun {
		t.Fatalf("unexpected automation config: %#v", cfg)
	}
	if !reflect.DeepEqual(cfg.CourseDetailCourseIDs, []string{"259772", "259773"}) {
		t.Fatalf("course ids = %v", cfg.CourseDetailCourseIDs)
	}
}
