package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// 固化学期：把全校学生的课表快照批量刷新到 D1。
//
// 为什么需要它：学号查询走的是实时链路，每次都现抓现算，所以**学分数字不依赖这个
// 任务**（实时查询会直接重新计算）。它真正保的是 D1 里的
// 兜底快照——教务或 VPS 不可用时前台读的就是那份——以及顺带把按学期缓存喂热。
//
// 为什么必须是长任务：教务课表页是有状态的 ASP.NET 表单，翻页要带上一次响应的
// __VIEWSTATE，多个学生并发会互相踩掉会话。实测单个学生约 1.5s，28818 人 ≈ 12~16
// 小时。所以它被设计成可暂停、可续跑、可限速的后台任务，而不是一个请求里干完。
//
// **两种用法，用 Scope 区分**（挑错了不会报错，只会一个人都选不出来或者白跑一遍）：
//
//   - scopeMissing「只补缺」：快照里没有目标学期的课的人才抓。用于学期结束、成绩
//     出完后把那一学期冻成最终版——天然增量，第二次跑几乎没人要处理。
//   - scopeStale「按快照新旧」：本次任务开始时刻之前写入的快照全部重抓。用于**学期
//     进行中**（选课刚结束）把全校课表缓存成当前版本：这时每个人的 record_json 里
//     本来就带着目标学期（`termLabel` 就是它，选课前的预排课也在里面），只补缺会
//     筛出 0 个人。
//
// 「只补缺」认的是**课级**证据 `"semester":"<学期>"` 而不是学期串本身，正是因为
// termLabel 会让整表命中；两种 JSON 间距各写一条 LIKE，是因为老快照由 Python 的
// build_student_records.py 写入（`"semester": "…"` 带空格），新的由本进程写入（无空格）。

const (
	// finalizeDefaultDelay throttles requests to the school's server. 1.2s plus
	// the ~1.5s each fetch already takes keeps this well under 1 req/s sustained.
	finalizeDefaultDelay = 1200 * time.Millisecond
	// finalizeMaxConsecutiveFailures aborts a run that is failing systematically
	// (session dead, 教务 down) instead of hammering for hours.
	finalizeMaxConsecutiveFailures = 20
	// finalizeScopeMissing / finalizeScopeStale pick which students still need
	// work. See the file comment above for when each one is the right answer.
	finalizeScopeMissing = "missing"
	finalizeScopeStale   = "stale"
	// d1TimeLayout is what D1's datetime('now') writes into updated_at, and hence
	// the only format a cutoff comparison against that column may use.
	d1TimeLayout = "2006-01-02 15:04:05"
)

// FinalizeOptions is one run's request. It is a struct because the panel now
// chooses five independent things, and a five-positional Start() invited exactly
// the kind of silent argument swap this batch cannot afford.
type FinalizeOptions struct {
	TargetTerm string
	// Limit > 0 restricts the run to that many students (the smoke test).
	Limit   int
	DelayMs int
	Resume  bool
	Scope   string
	// AdvanceFinalizedTerm makes a completed full run also set 日常设置 的
	// 「已结束学期」. It is **opt-in**: declaring a term finalized moves its credits
	// into 已修学分, which is wrong for the semester currently being taught — and
	// caching an in-progress semester's timetable is now a first-class use of this
	// batch.
	AdvanceFinalizedTerm bool
}

// FinalizeState is the persisted, panel-visible state of the batch.
type FinalizeState struct {
	// State: idle / running / paused / done / failed / cancelled
	State        string `json:"state"`
	TargetTerm   string `json:"targetTerm"`
	Total        int    `json:"total"`
	Processed    int    `json:"processed"`
	Updated      int    `json:"updated"`
	Skipped      int    `json:"skipped"`
	Failed       int    `json:"failed"`
	Cursor       string `json:"cursor"`
	Limit        int    `json:"limit"`
	DelayMs      int    `json:"delayMs"`
	Scope        string `json:"scope"`
	// Cutoff is the scopeStale boundary: snapshots written before it are refreshed.
	// It is frozen at the first Start so a resumed run keeps one logical pass, and
	// so students refreshed meanwhile (by this run or by a live query) drop out.
	Cutoff               string `json:"cutoff"`
	AdvanceFinalizedTerm bool   `json:"advanceFinalizedTerm"`
	SmokeTest            bool   `json:"smokeTest"`
	StartedAt            string `json:"startedAt"`
	FinishedAt   string `json:"finishedAt"`
	Message      string `json:"message"`
	LastError    string `json:"lastError"`
	LastStudent  string `json:"lastStudent"`
	LastDuration string `json:"lastDuration"`
}

type FinalizeService struct {
	env    Environment
	config *ConfigStore
	live   *LiveStudentService
	logger *slog.Logger
	path   string

	mu     sync.Mutex
	state  FinalizeState
	cancel context.CancelFunc
	paused bool
	// cloudflare is resolved lazily so credential changes in the panel are picked
	// up without a restart.
	clientFor func() *CloudflarePagesClient
}

func NewFinalizeService(env Environment, config *ConfigStore, live *LiveStudentService, logger *slog.Logger, clientFor func() *CloudflarePagesClient) *FinalizeService {
	service := &FinalizeService{
		env: env, config: config, live: live, logger: logger,
		path:      filepath.Join(filepath.Dir(env.ConfigPath), "finalize_state.json"),
		clientFor: clientFor,
	}
	service.load()
	return service
}

func (f *FinalizeService) load() {
	raw, err := os.ReadFile(f.path)
	if err != nil {
		f.state = FinalizeState{State: "idle", DelayMs: int(finalizeDefaultDelay / time.Millisecond)}
		return
	}
	if err := json.Unmarshal(raw, &f.state); err != nil {
		f.state = FinalizeState{State: "idle", DelayMs: int(finalizeDefaultDelay / time.Millisecond)}
		return
	}
	// A crash mid-run must not leave the panel claiming it is still running.
	if f.state.State == "running" {
		f.state.State = "paused"
		f.state.Message = "后端重启中断了上一次固化，可从断点继续"
	}
}

func (f *FinalizeService) persistLocked() {
	raw, err := json.Marshal(f.state)
	if err != nil {
		return
	}
	_ = atomicWrite(f.path, raw, 0o600)
}

func (f *FinalizeService) Status() FinalizeState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

// studentsClient points at the jxnu-students database, which is separate from
// the reviews database the rest of the panel uses.
func (f *FinalizeService) studentsClient() (*CloudflarePagesClient, error) {
	base := f.clientFor()
	id := f.env.CFD1StudentsDatabaseID
	if id == "" {
		return nil, errors.New("未配置学号快照库（CF_D1_STUDENTS_DATABASE_ID），请在部署配置页填写")
	}
	client := base.ForDatabase(id)
	if !client.D1Ready() {
		return nil, errors.New("Cloudflare D1 凭据未配置")
	}
	return client, nil
}

// Start launches a run. opts.Limit > 0 restricts it to that many students, which
// is how the smoke test proves the whole path without a 12-hour commitment.
func (f *FinalizeService) Start(opts FinalizeOptions) error {
	if !termPattern.MatchString(opts.TargetTerm) {
		return fmt.Errorf("目标学期必须类似 25-26第2学期")
	}
	if opts.DelayMs < 200 || opts.DelayMs > 60000 {
		return fmt.Errorf("请求间隔须为 200–60000 毫秒")
	}
	if opts.Scope != finalizeScopeMissing && opts.Scope != finalizeScopeStale {
		return fmt.Errorf("刷新范围只能是「只补缺」或「按快照新旧」")
	}
	if _, err := f.studentsClient(); err != nil {
		return err
	}

	f.mu.Lock()
	if f.state.State == "running" {
		f.mu.Unlock()
		return errors.New("固化任务已在运行")
	}
	previous := f.state
	now := time.Now()
	f.state = FinalizeState{
		State: "running", TargetTerm: opts.TargetTerm, Limit: opts.Limit, DelayMs: opts.DelayMs,
		Scope: opts.Scope, Cutoff: now.UTC().Format(d1TimeLayout), AdvanceFinalizedTerm: opts.AdvanceFinalizedTerm,
		SmokeTest: opts.Limit > 0, StartedAt: now.UTC().Format(time.RFC3339),
		Message: "正在统计待处理学生…",
	}
	if opts.Resume && previous.TargetTerm == opts.TargetTerm {
		// Resume keeps the cursor and the running totals so a paused run does not
		// restart from the beginning of 28k students.
		f.state.Cursor = previous.Cursor
		f.state.Processed = previous.Processed
		f.state.Updated = previous.Updated
		f.state.Skipped = previous.Skipped
		f.state.Failed = previous.Failed
		// …and the original cutoff, so continuing is continuing rather than
		// re-opening the window over everything this run already wrote back.
		if previous.Cutoff != "" {
			f.state.Cutoff = previous.Cutoff
		}
	}
	state := f.state
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	f.paused = false
	f.persistLocked()
	f.mu.Unlock()

	go f.run(ctx, opts, state.Cutoff, time.Duration(opts.DelayMs)*time.Millisecond)
	return nil
}

func (f *FinalizeService) Pause() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state.State != "running" {
		return errors.New("当前没有正在运行的固化任务")
	}
	f.paused = true
	return nil
}

func (f *FinalizeService) Cancel() error {
	f.mu.Lock()
	cancel := f.cancel
	running := f.state.State == "running"
	f.mu.Unlock()
	if !running || cancel == nil {
		return errors.New("当前没有正在运行的固化任务")
	}
	cancel()
	return nil
}

func (f *FinalizeService) finish(state, message string) {
	f.mu.Lock()
	f.state.State = state
	f.state.Message = message
	f.state.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	f.persistLocked()
	f.mu.Unlock()
}

// finalizePendingQuery builds "who still needs work", forward from the cursor.
// taken_count comes along so the run can refuse to overwrite a populated
// snapshot with an empty fetch (see refreshOne).
func finalizePendingQuery(opts FinalizeOptions, cursor, cutoff string) (string, []any) {
	sql := `SELECT student_id, taken_count FROM student_records WHERE student_id > ?`
	params := []any{cursor}
	if opts.Scope == finalizeScopeStale {
		sql += ` AND (updated_at IS NULL OR updated_at < ?)`
		params = append(params, cutoff)
	} else {
		// Course-level evidence only: every record's termLabel already carries the
		// term 教务 is currently in, so matching the bare term string would skip the
		// entire table. Two spacings = two writers (Python importer / this backend).
		sql += ` AND (record_json IS NULL OR (record_json NOT LIKE ? AND record_json NOT LIKE ?))`
		params = append(params, `%"semester":"`+opts.TargetTerm+`"%`, `%"semester": "`+opts.TargetTerm+`"%`)
	}
	sql += ` ORDER BY student_id`
	if opts.Limit > 0 {
		sql += ` LIMIT ?`
		params = append(params, opts.Limit)
	}
	return sql, params
}

func (f *FinalizeService) run(ctx context.Context, opts FinalizeOptions, cutoff string, delay time.Duration) {
	client, err := f.studentsClient()
	if err != nil {
		f.finish("failed", err.Error())
		return
	}

	// The whole 384MB table is scanned once per run (measured ~0.6s server-side)
	// — expensive but paid once, and it is what keeps the batch itself a simple
	// forward walk over a fixed list.
	listCtx, cancelList := context.WithTimeout(ctx, D1RequestTimeout)
	sql, params := finalizePendingQuery(opts, f.Status().Cursor, cutoff)
	rows, _, err := client.D1Query(listCtx, sql, params)
	cancelList()
	if err != nil {
		f.finish("failed", "统计待处理学生失败："+err.Error())
		return
	}

	f.mu.Lock()
	f.state.Total = f.state.Processed + len(rows)
	f.state.Message = fmt.Sprintf("待处理 %d 人", len(rows))
	f.persistLocked()
	f.mu.Unlock()
	f.logger.Info("固化学期开始", "targetTerm", opts.TargetTerm, "scope", opts.Scope, "pending", len(rows),
		"limit", opts.Limit, "delayMs", delay.Milliseconds(), "advanceFinalizedTerm", opts.AdvanceFinalizedTerm)

	if len(rows) == 0 {
		empty := "没有需要固化的学生（快照都已包含该学期的课）"
		if opts.Scope == finalizeScopeStale {
			empty = "没有需要固化的学生（快照都比本次任务的开始时刻新）"
		}
		f.completeRun(opts.TargetTerm, empty)
		return
	}

	consecutiveFailures := 0
	for _, row := range rows {
		sid := reviewText(row, "student_id")
		if sid == "" {
			continue
		}
		if ctx.Err() != nil {
			f.finish("cancelled", "已取消，可从断点继续")
			return
		}
		f.mu.Lock()
		paused := f.paused
		f.mu.Unlock()
		if paused {
			f.finish("paused", "已暂停，可从断点继续")
			return
		}

		started := time.Now()
		wrote, err := f.refreshOne(ctx, client, sid, reviewInt(row, "taken_count"))
		if err != nil {
			if ctx.Err() != nil {
				f.finish("cancelled", "已取消，可从断点继续")
				return
			}
			consecutiveFailures++
			sanitizedError := redactStudentID(err.Error(), sid)
			f.mu.Lock()
			f.state.Failed++
			f.state.Processed++
			f.state.Cursor = sid
			f.state.LastError = sanitizedError
			f.persistLocked()
			f.mu.Unlock()
			f.logger.Warn("固化单个学号失败", "student", maskedStudentID(sid), "error", sanitizedError)
			if consecutiveFailures >= finalizeMaxConsecutiveFailures {
				f.finish("failed", fmt.Sprintf("连续 %d 个学号失败，已中止以免持续打扰教务；最后一条错误：%s", consecutiveFailures, sanitizedError))
				return
			}
		} else {
			consecutiveFailures = 0
			f.mu.Lock()
			if wrote {
				f.state.Updated++
			} else {
				f.state.Skipped++
			}
			f.state.Processed++
			f.state.Cursor = sid
			f.state.LastStudent = sid
			f.state.LastDuration = time.Since(started).Truncate(time.Millisecond).String()
			f.state.Message = fmt.Sprintf("已处理 %d / %d", f.state.Processed, f.state.Total)
			f.persistLocked()
			f.mu.Unlock()
		}

		select {
		case <-ctx.Done():
			f.finish("cancelled", "已取消，可从断点继续")
			return
		case <-time.After(delay):
		}
	}
	f.completeRun(opts.TargetTerm, "")
}

// completeRun marks success and, when the operator asked for it, advances
// finalizedTerm — declaring a term's grades final is a separate decision from
// refreshing its snapshots, and only ever right for a term that has ended.
func (f *FinalizeService) completeRun(targetTerm, message string) {
	status := f.Status()
	if message == "" {
		message = fmt.Sprintf("完成：更新 %d 人，跳过 %d 人（教务已查不到课程，保留原快照），失败 %d 人", status.Updated, status.Skipped, status.Failed)
	}
	if status.SmokeTest {
		f.finish("done", "冒烟测试"+message+"（未改动「已结束学期」设置）")
		return
	}
	if !status.AdvanceFinalizedTerm {
		f.finish("done", message+"；未改动「已结束学期」（本次只刷新快照）")
		return
	}
	cfg := f.config.Get()
	if cfg.FinalizedTerm != targetTerm {
		cfg.FinalizedTerm = targetTerm
		if err := f.config.Save(cfg); err != nil {
			f.finish("done", message+"；但自动设置「已结束学期」失败："+err.Error())
			return
		}
		f.live.ClearCache()
		message += fmt.Sprintf("；已把「已结束学期」设为 %s，该学期学分即刻计入已修", targetTerm)
	}
	f.finish("done", message)
}

// refreshOne re-fetches one student and writes the snapshot back. Returns false
// when it deliberately declined to write.
//
// previousTaken guards the one destructive case in this whole batch: 教务 answers
// "no courses" for a student who has graduated, transferred, or whose page simply
// came back empty that second. Overwriting a populated snapshot with that would
// silently destroy the only copy — and this run is unattended for hours. An empty
// fetch against a populated snapshot therefore keeps the old data.
func (f *FinalizeService) refreshOne(ctx context.Context, client *CloudflarePagesClient, sid string, previousTaken int) (bool, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	built, err := f.live.RefreshRecord(fetchCtx, sid)
	if err != nil {
		return false, err
	}
	if reviewInt(built.Row, "taken_count") == 0 && previousTaken > 0 {
		f.logger.Warn("固化跳过：教务返回空课表但已有非空快照，保留原数据", "student", maskedStudentID(sid), "previousTaken", previousTaken)
		return false, nil
	}
	payload, err := json.Marshal(built.Record)
	if err != nil {
		return false, err
	}
	writeCtx, cancelWrite := context.WithTimeout(ctx, D1RequestTimeout)
	defer cancelWrite()
	_, _, err = client.D1Query(writeCtx,
		`INSERT OR REPLACE INTO student_records
		   (student_id, class_name, plan_key, total_earned, taken_count, record_json, updated_at)
		 VALUES (?,?,?,?,?,?,datetime('now'))`,
		[]any{sid, built.Row["class_name"], built.Row["plan_key"], built.Row["total_earned"], built.Row["taken_count"], string(payload)})
	return err == nil, err
}
