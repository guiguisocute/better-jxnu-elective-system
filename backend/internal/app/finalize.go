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

// 固化学期：把全校学生的课表快照刷成「某个已结束学期为止」的最终版。
//
// 为什么需要它：学号查询走的是实时链路，每次都现抓现算，所以**学分数字不依赖这个
// 任务**（999999999999 从 87 变 109 就没跑过任何批处理）。它真正保的是 D1 里的
// 兜底快照——教务或 VPS 不可用时前台读的就是那份——以及顺带把按学期缓存喂热。
//
// 为什么必须是长任务：教务课表页是有状态的 ASP.NET 表单，翻页要带上一次响应的
// __VIEWSTATE，多个学生并发会互相踩掉会话。实测单个学生约 1.5s，28818 人 ≈ 12~16
// 小时。所以它被设计成可暂停、可续跑、可限速的后台任务，而不是一个请求里干完。
//
// 「只补缺的」：快照的 record_json 里已经含有目标学期的学生直接跳过，用一条
// D1 的 NOT LIKE 在服务端筛掉。首次全量跑完之后，以后每学期只补增量。

const (
	// finalizeDefaultDelay throttles requests to the school's server. 1.2s plus
	// the ~1.5s each fetch already takes keeps this well under 1 req/s sustained.
	finalizeDefaultDelay = 1200 * time.Millisecond
	// finalizeMaxConsecutiveFailures aborts a run that is failing systematically
	// (session dead, 教务 down) instead of hammering for hours.
	finalizeMaxConsecutiveFailures = 20
)

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
	SmokeTest    bool   `json:"smokeTest"`
	StartedAt    string `json:"startedAt"`
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

// Start launches a run. limit > 0 restricts it to that many students, which is
// how the smoke test proves the whole path without a 12-hour commitment.
func (f *FinalizeService) Start(targetTerm string, limit, delayMs int, resume bool) error {
	if !termPattern.MatchString(targetTerm) {
		return fmt.Errorf("目标学期必须类似 25-26第2学期")
	}
	if delayMs < 200 || delayMs > 60000 {
		return fmt.Errorf("请求间隔须为 200–60000 毫秒")
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
	f.state = FinalizeState{
		State: "running", TargetTerm: targetTerm, Limit: limit, DelayMs: delayMs,
		SmokeTest: limit > 0, StartedAt: time.Now().UTC().Format(time.RFC3339),
		Message: "正在统计待处理学生…",
	}
	if resume && previous.TargetTerm == targetTerm {
		// Resume keeps the cursor and the running totals so a paused run does not
		// restart from the beginning of 28k students.
		f.state.Cursor = previous.Cursor
		f.state.Processed = previous.Processed
		f.state.Updated = previous.Updated
		f.state.Skipped = previous.Skipped
		f.state.Failed = previous.Failed
	}
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	f.paused = false
	f.persistLocked()
	f.mu.Unlock()

	go f.run(ctx, targetTerm, limit, time.Duration(delayMs)*time.Millisecond)
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

func (f *FinalizeService) run(ctx context.Context, targetTerm string, limit int, delay time.Duration) {
	client, err := f.studentsClient()
	if err != nil {
		f.finish("failed", err.Error())
		return
	}

	// Only students whose snapshot does not yet mention the target term. The
	// LIKE scans the whole 289MB table once per run — expensive but paid once,
	// and it is what turns every later semester into a small incremental job.
	listCtx, cancelList := context.WithTimeout(ctx, D1RequestTimeout)
	// taken_count comes along so the run can refuse to overwrite a populated
	// snapshot with an empty fetch (see refreshOne).
	sql := `SELECT student_id, taken_count FROM student_records WHERE student_id > ? AND (record_json IS NULL OR record_json NOT LIKE ?) ORDER BY student_id`
	params := []any{f.Status().Cursor, "%" + targetTerm + "%"}
	if limit > 0 {
		sql += ` LIMIT ?`
		params = append(params, limit)
	}
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
	f.logger.Info("固化学期开始", "targetTerm", targetTerm, "pending", len(rows), "limit", limit, "delayMs", delay.Milliseconds())

	if len(rows) == 0 {
		f.completeRun(targetTerm, "没有需要固化的学生（快照都已包含该学期）")
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
			f.mu.Lock()
			f.state.Failed++
			f.state.Processed++
			f.state.Cursor = sid
			f.state.LastError = err.Error()
			f.persistLocked()
			f.mu.Unlock()
			f.logger.Warn("固化单个学号失败", "sid", sid, "error", err)
			if consecutiveFailures >= finalizeMaxConsecutiveFailures {
				f.finish("failed", fmt.Sprintf("连续 %d 个学号失败，已中止以免持续打扰教务；最后一条错误：%s", consecutiveFailures, err))
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
	f.completeRun(targetTerm, "")
}

// completeRun marks success and, for a full run, advances finalizedTerm — the
// act of freezing a semester is the same act as declaring its grades final.
func (f *FinalizeService) completeRun(targetTerm, message string) {
	status := f.Status()
	if message == "" {
		message = fmt.Sprintf("完成：更新 %d 人，跳过 %d 人（教务已查不到课程，保留原快照），失败 %d 人", status.Updated, status.Skipped, status.Failed)
	}
	if status.SmokeTest {
		f.finish("done", "冒烟测试"+message+"（未改动「已结束学期」设置）")
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
		f.logger.Warn("固化跳过：教务返回空课表但已有非空快照，保留原数据", "sid", sid, "previousTaken", previousTaken)
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
