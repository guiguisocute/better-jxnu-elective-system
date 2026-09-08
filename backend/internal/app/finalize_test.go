package app

import (
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
)

// 「只补缺」认的必须是**课级**证据。用裸学期串（老写法 `%26-27第1学期%`）会命中每份
// 快照的 termLabel——教务一开放选课就把当前学期切到下一个，于是全表 28821 行都"已包含
// 该学期"，任务一个人都选不出来，面板上却显示"完成"。
func TestFinalizePendingQueryMissingMatchesCourseLevelOnly(t *testing.T) {
	sql, params := finalizePendingQuery(FinalizeOptions{TargetTerm: "26-27第1学期", Scope: finalizeScopeMissing}, "", "")
	if !strings.Contains(sql, "record_json NOT LIKE ?") {
		t.Fatalf("missing scope should filter on record_json: %s", sql)
	}
	if strings.Contains(sql, "updated_at") {
		t.Fatalf("missing scope must not use the staleness cutoff: %s", sql)
	}
	patterns := []string{`%"semester":"26-27第1学期"%`, `%"semester": "26-27第1学期"%`}
	for _, want := range patterns {
		found := false
		for _, param := range params[1:] {
			if param == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("expected LIKE pattern %q in %v", want, params)
		}
	}
	for _, param := range params {
		if param == `%26-27第1学期%` {
			t.Fatal("bare term pattern matches termLabel and would skip the whole table")
		}
	}
}

// 在读学期靠"快照比本次任务开始得早"选人，因为课级证据这时人人都有（选课前的预排课
// 已经写进快照了），只补缺会筛出 0 人。
func TestFinalizePendingQueryStaleUsesCutoff(t *testing.T) {
	sql, params := finalizePendingQuery(
		FinalizeOptions{TargetTerm: "26-27第1学期", Scope: finalizeScopeStale}, "202400000000", "2026-09-08 10:00:00")
	if !strings.Contains(sql, "updated_at < ?") {
		t.Fatalf("stale scope should compare updated_at: %s", sql)
	}
	if strings.Contains(sql, "record_json") {
		t.Fatalf("stale scope must not filter on record_json: %s", sql)
	}
	if len(params) != 2 || params[0] != "202400000000" || params[1] != "2026-09-08 10:00:00" {
		t.Fatalf("unexpected params: %v", params)
	}
}

func TestFinalizePendingQueryLimitsSmokeTest(t *testing.T) {
	sql, params := finalizePendingQuery(FinalizeOptions{TargetTerm: "25-26第2学期", Scope: finalizeScopeStale, Limit: 5}, "", "cutoff")
	if !strings.HasSuffix(sql, "ORDER BY student_id LIMIT ?") {
		t.Fatalf("limit must come after the ordering: %s", sql)
	}
	if params[len(params)-1] != 5 {
		t.Fatalf("limit value missing: %v", params)
	}
}

// 推进「已结束学期」是独立的、要手动勾的决定：把在读学期宣布为已结束，会让还没出分的
// 课立刻算进已修学分。
func TestCompleteRunLeavesFinalizedTermAloneUnlessAsked(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenConfigStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := store.Get()
	cfg.FinalizedTerm = "25-26第2学期"
	if err := store.Save(cfg); err != nil {
		t.Fatal(err)
	}
	service := &FinalizeService{
		config: store,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		path:   filepath.Join(dir, "finalize_state.json"),
		state:  FinalizeState{State: "running", TargetTerm: "26-27第1学期", Scope: finalizeScopeStale},
	}
	service.completeRun("26-27第1学期", "")
	if got := store.Get().FinalizedTerm; got != "25-26第2学期" {
		t.Fatalf("finalized term changed without opt-in: %s", got)
	}
	if state := service.Status(); state.State != "done" || !strings.Contains(state.Message, "未改动「已结束学期」") {
		t.Fatalf("unexpected final state: %+v", state)
	}
}
