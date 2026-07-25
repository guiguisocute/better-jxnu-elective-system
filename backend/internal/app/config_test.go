package app

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
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
	cfg = DefaultRuntimeConfig()
	cfg.SelectionCapacityURL = "https://example.com/Step3/ChangeClass.aspx?kch={courseId}"
	if err := cfg.Validate(); err == nil {
		t.Fatal("off-host capacity URL accepted")
	}
}

func TestCapacityURLTemplateValidation(t *testing.T) {
	for _, valid := range []string{
		DefaultCapacityURL,
		"https://xk.jxnu.edu.cn/Step4/ChangeClass.aspx?action=change&kch={courseId}",
	} {
		if err := validateCapacityURL(valid); err != nil {
			t.Fatalf("valid URL rejected: %s: %v", valid, err)
		}
	}
	for _, invalid := range []string{
		"https://xk.jxnu.edu.cn/Step3/ChangeClass.aspx?kch=fixed",
		"https://xk.jxnu.edu.cn:444/Step3/ChangeClass.aspx?kch={courseId}",
		"http://xk.jxnu.edu.cn/Step3/ChangeClass.aspx?kch={courseId}",
	} {
		if err := validateCapacityURL(invalid); err == nil {
			t.Fatalf("invalid URL accepted: %s", invalid)
		}
	}
}

func TestConfigStoreMigratesLegacyAndDropsTrackedCourseFields(t *testing.T) {
	path := t.TempDir() + "/config.json"
	legacy := DefaultRuntimeConfig()
	legacy.Version = 3
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	document["courseDetailsVerifyTrackedEveryRun"] = true
	document["courseDetailCourseIds"] = []string{"259772", "269729"}
	raw, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if store.Get().Version != 6 {
		t.Fatalf("migration result = %#v", store.Get())
	}
	updated, err := os.ReadFile(path)
	document = map[string]any{}
	if err != nil || json.Unmarshal(updated, &document) != nil {
		t.Fatalf("read migrated config: %v", err)
	}
	if _, exists := document["courseDetailCourseIds"]; exists {
		t.Fatalf("legacy course whitelist was persisted: %s", updated)
	}
	if _, exists := document["courseDetailsVerifyTrackedEveryRun"]; exists {
		t.Fatalf("legacy verify flag was persisted: %s", updated)
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
	target, ok := ResolveAcquisitionTarget("2027-03")
	if !ok || target.AcademicTerm != "26-27第2学期" || target.SchoolDate != "2027/3/1 0:00:00" {
		t.Fatalf("target = %#v, %v", target, ok)
	}
}

func TestSemesterTargetOptionsIncludesFutureAndSelected(t *testing.T) {
	options := SemesterTargetOptions([]string{"2026-09"}, "2030-03", time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC))
	for _, want := range []string{"2026-09", "2027-03", "2028-09", "2030-03"} {
		if !contains(options, want) {
			t.Fatalf("missing %s in %v", want, options)
		}
	}
}

func TestConfigStoreRoundTrip(t *testing.T) {
	path := t.TempDir() + "/config.json"
	store, err := OpenConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg := store.Get()
	cfg.DefaultDataSource = "formal"
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
		"selectionScheduleWatchEnabled": "on", "formalScheduleStableChecks": "3",
		"courseDetailsEnabled":      "on",
		"courseDetailsRefreshHours": "72", "courseDetailsMaxPerRun": "40",
		"courseDetailsDelayMilliseconds": "500",
	}, DefaultRuntimeConfig())
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AutoSyncEnabled || cfg.AutoSyncIntervalMinutes != 120 || !cfg.SelectionScheduleWatchEnabled || cfg.FormalScheduleStableChecks != 3 || !cfg.CourseDetailsEnabled {
		t.Fatalf("unexpected automation config: %#v", cfg)
	}
}

func TestActiveAcquisitionProfileSeparatesPreselectFromSharedSelection(t *testing.T) {
	cfg := DefaultRuntimeConfig()
	cfg.PreselectSemester = "2027-03"
	cfg.SelectionSemester = "2026-09"
	cfg.DefaultDataSource = "pre"
	pre := cfg.ActiveAcquisitionProfile()
	if pre.RawFilename != "preselect_catalog.json" || pre.KKAPEnabled || pre.LiveEnrollment || cfg.LiveEnrollmentTarget() != "" {
		t.Fatalf("pre profile = %#v", pre)
	}
	cfg.DefaultDataSource = "formal"
	selection := cfg.ActiveAcquisitionProfile()
	if selection.Semester != "2026-09" || selection.RawFilename != "formal_schedule.json" || selection.CapacityFilename != "formal_capacity.json" || selection.Label != "正选/补退选" || selection.CapacityURL != DefaultCapacityURL {
		t.Fatalf("selection profile = %#v", selection)
	}
}

func TestConfigStoreMigratesV4SharedTargetToStageTargets(t *testing.T) {
	path := t.TempDir() + "/config.json"
	raw := []byte(`{"version":4,"defaultDataSource":"formal","liveEnrollmentSemester":"2026-09","scheduleSyncSemester":"2027-03","studentScheduleTerm":"","enrollmentRefreshSeconds":30,"studentCacheSeconds":600,"capacityEnabled":true,"capacityStep":"Step2","capacityDelayMilliseconds":100,"minScheduleRows":6000,"minFormalSections":7000,"minCapacityVisible":300,"allowedOrigins":[],"autoSyncEnabled":true,"autoSyncIntervalMinutes":60,"formalScheduleWatchEnabled":true,"formalScheduleStableChecks":2,"courseDetailsEnabled":true,"courseDetailsRefreshHours":168,"courseDetailsMaxPerRun":30,"courseDetailsDelayMilliseconds":300}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg := store.Get()
	if cfg.Version != 6 || cfg.PreselectSemester != "2027-03" || cfg.SelectionSemester != "2027-03" || !cfg.SelectionCapacityEnabled || !strings.Contains(cfg.SelectionCapacityURL, "/Step2/") || cfg.MinSelectionSections != 4000 {
		t.Fatalf("migration result = %#v", cfg)
	}
}

func TestSemesterFromSchoolDate(t *testing.T) {
	cases := map[string]string{
		"2026/9/1 0:00:00": "2026-09",
		"2027/3/1 0:00:00": "2027-03",
	}
	for input, want := range cases {
		got, ok := SemesterFromSchoolDate(input)
		if !ok || got != want {
			t.Errorf("%q => %q,%v want %q", input, got, ok, want)
		}
	}
	if _, ok := SemesterFromSchoolDate("2027/6/1 0:00:00"); ok {
		t.Fatal("unexpected non-semester month accepted")
	}
}
