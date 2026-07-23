package app

import (
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestOperationsPageRendersKKAPWatcherAndBuildModes(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenConfigStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	env := Environment{ConfigPath: store.Path(), RepoDir: dir}
	admin := &AdminServer{env: env, config: store, syncRunner: NewSyncRunner(env, store, logger)}
	recorder := httptest.NewRecorder()
	admin.operations(recorder, httptest.NewRequest("GET", "/operations", nil), adminSession{CSRF: "test-csrf"})
	body := recorder.Body.String()
	for _, want := range []string{"正选/补退选 KKAP 课表守候", "唯一的 <code>formal_schedule.json</code>", "2026-09 → 26-27第1学期", "仅构建现有 raw", "formalScheduleStableChecks", "无需维护课程号名单"} {
		if !strings.Contains(body, want) {
			t.Fatalf("operations page missing %q", want)
		}
	}
	if strings.Contains(body, "%!") {
		t.Fatalf("fmt placeholder error in operations page: %s", body)
	}
}

func TestSettingsAndAdvancedPagesRenderStageSpecificTargets(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenConfigStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	env := Environment{ConfigPath: store.Path(), RepoDir: dir}
	admin := &AdminServer{env: env, config: store, live: &LiveStudentService{}, syncRunner: NewSyncRunner(env, store, logger)}
	for path, testCase := range map[string]struct {
		render func(*httptest.ResponseRecorder)
		wants  []string
	}{
		"settings": {func(rec *httptest.ResponseRecorder) {
			admin.settings(rec, httptest.NewRequest("GET", "/settings", nil), adminSession{CSRF: "x"})
		}, []string{"preselectSemester", "selectionSemester", "正选/补退选数据写入哪个学期", "当前联网采集器保持关闭"}},
		"advanced": {func(rec *httptest.ResponseRecorder) {
			admin.advanced(rec, httptest.NewRequest("GET", "/advanced", nil), adminSession{CSRF: "x"})
		}, []string{"selectionCapacityUrl", "{courseId}", "minSelectionSections"}},
	} {
		recorder := httptest.NewRecorder()
		testCase.render(recorder)
		body := recorder.Body.String()
		for _, want := range testCase.wants {
			if !strings.Contains(body, want) {
				t.Fatalf("%s page missing %q", path, want)
			}
		}
		if strings.Contains(body, "%!") {
			t.Fatalf("%s fmt placeholder error", path)
		}
	}
}
