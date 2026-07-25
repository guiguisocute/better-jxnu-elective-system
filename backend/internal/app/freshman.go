package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// 新生嗅探：每年新生入学前后，教务会分批把这一届的 学号名单 和 培养方案 放出来，
// 但不会通知任何人，也没有「已就绪」的标志位。以前只能隔几天手动去点一遍页面。
//
// 两个面分开监听，因为它们不同时到位，用途也不同：
//   - 学号名单：到位后可以把新生补进 student_records，他们才查得到自己的课表；
//   - 培养方案：到位后 data/master_raw/training_plan.json 才能补这一届，学分核算
//     才认得这个年级。
//
// 「查得到」不等于「齐了」——2026 级方案在 2026-07 就能查到，但只有公共必修和
// 专业类基础两张表。所以两个探针都记录**数量**而不只是有无，面板上显示的是
// 「扫了多少、出了多少」，由人来判断这一批算不算齐。

const (
	// freshmanSniffDelay throttles the school's server. 嗅探是后台任务，没有人在等，
	// 慢一点换个安分。
	freshmanSniffDelay = 700 * time.Millisecond
	// freshmanPlanSamples is how many majors a cheap plan check looks at. 288 个专业
	// 全扫一遍要 4 分钟，而「这一届开始铺方案了吗」这个问题，均匀抽十几个就够答。
	freshmanPlanSamples = 12
	// freshmanMaxFailures aborts a sweep that is failing systematically.
	freshmanMaxFailures = 10
)

// FreshmanProbe is one target's persisted, panel-visible state.
type FreshmanProbe struct {
	// State: idle / running / waiting（还没出数据）/ found / failed
	State         string   `json:"state"`
	Grade         string   `json:"grade"`
	Scanned       int      `json:"scanned"`
	Found         int      `json:"found"`
	Total         int      `json:"total"`
	Full          bool     `json:"full"`
	Highlights    []string `json:"highlights,omitempty"`
	Message       string   `json:"message"`
	LastError     string   `json:"lastError,omitempty"`
	LastCheckedAt string   `json:"lastCheckedAt,omitempty"`
	LastFoundAt   string   `json:"lastFoundAt,omitempty"`
	ImportedAt    string   `json:"importedAt,omitempty"`
	Imported      int      `json:"imported"`
	SnapshotPath  string   `json:"snapshotPath,omitempty"`
}

type FreshmanState struct {
	Roster FreshmanProbe `json:"roster"`
	Plan   FreshmanProbe `json:"plan"`
}

type FreshmanService struct {
	env       Environment
	config    *ConfigStore
	live      *LiveStudentService
	logger    *slog.Logger
	path      string
	clientFor func() *CloudflarePagesClient

	mu      sync.Mutex
	state   FreshmanState
	running map[string]bool
	wake    chan struct{}
}

func NewFreshmanService(env Environment, config *ConfigStore, live *LiveStudentService, logger *slog.Logger, clientFor func() *CloudflarePagesClient) *FreshmanService {
	service := &FreshmanService{
		env: env, config: config, live: live, logger: logger,
		path:      filepath.Join(filepath.Dir(env.ConfigPath), "freshman_watch.json"),
		clientFor: clientFor,
		running:   map[string]bool{},
		wake:      make(chan struct{}, 1),
	}
	service.load()
	return service
}

func (f *FreshmanService) load() {
	raw, err := os.ReadFile(f.path)
	if err != nil {
		return
	}
	_ = json.Unmarshal(raw, &f.state)
	// 进程重启会打断扫描，别让面板一直显示「运行中」。
	for _, probe := range []*FreshmanProbe{&f.state.Roster, &f.state.Plan} {
		if probe.State == "running" {
			probe.State = "idle"
			probe.Message = "后端重启中断了上一次扫描"
		}
	}
}

func (f *FreshmanService) persistLocked() {
	if raw, err := json.Marshal(f.state); err == nil {
		_ = atomicWrite(f.path, raw, 0o600)
	}
}

func (f *FreshmanService) Status() FreshmanState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *FreshmanService) probeOf(target string) *FreshmanProbe {
	if target == "plan" {
		return &f.state.Plan
	}
	return &f.state.Roster
}

// update mutates one target's state under the lock and persists it.
func (f *FreshmanService) update(target string, fn func(*FreshmanProbe)) {
	f.mu.Lock()
	fn(f.probeOf(target))
	f.persistLocked()
	f.mu.Unlock()
}

// begin claims a target, refusing to start a second concurrent scan of it.
func (f *FreshmanService) begin(target string, full bool, grade string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.running[target] {
		return errors.New("该嗅探正在运行，请等它结束")
	}
	f.running[target] = true
	probe := f.probeOf(target)
	*probe = FreshmanProbe{
		State: "running", Grade: grade, Full: full, Message: "正在扫描…",
		LastFoundAt: probe.LastFoundAt, ImportedAt: probe.ImportedAt,
		Imported: probe.Imported, SnapshotPath: probe.SnapshotPath,
	}
	f.persistLocked()
	return nil
}

func (f *FreshmanService) end(target, state, message string, err error) {
	f.mu.Lock()
	f.running[target] = false
	probe := f.probeOf(target)
	probe.State = state
	probe.Message = message
	probe.LastCheckedAt = time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		probe.LastError = err.Error()
	} else {
		probe.LastError = ""
	}
	if state == "found" {
		probe.LastFoundAt = probe.LastCheckedAt
	}
	f.persistLocked()
	f.mu.Unlock()
}

// Start runs one target's scan in the background.
func (f *FreshmanService) Start(target string, full bool) error {
	cfg := f.config.Get()
	grade := cfg.FreshmanGrade
	if gradePrefix(grade) == "" {
		return errors.New("新生年级必须是四位年份，例如 2026")
	}
	if target != "roster" && target != "plan" {
		return errors.New("未知的嗅探目标")
	}
	if err := f.begin(target, full, grade); err != nil {
		return err
	}
	go func() {
		// 与 HTTP 请求解耦：面板点一下就返回，扫描继续跑。
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Minute)
		defer cancel()
		var err error
		if target == "roster" {
			err = f.scanRoster(ctx, grade, full)
		} else {
			err = f.scanPlan(ctx, grade, full)
		}
		if err != nil {
			f.end(target, "failed", "扫描失败："+err.Error(), err)
			f.logger.Warn("新生嗅探失败", "target", target, "error", err)
		}
	}()
	return nil
}

// Run is the periodic loop. It only ever performs the cheap check; turning a
// discovery into stored data stays a deliberate human click.
func (f *FreshmanService) Run(ctx context.Context) {
	for {
		cfg := f.config.Get()
		interval := time.Duration(cfg.FreshmanWatchIntervalHours) * time.Hour
		if interval <= 0 {
			interval = 6 * time.Hour
		}
		select {
		case <-ctx.Done():
			return
		case <-f.wake:
		case <-time.After(interval):
		}
		cfg = f.config.Get()
		if cfg.FreshmanRosterWatchEnabled && f.dueFor("roster", interval) {
			if err := f.Start("roster", false); err != nil {
				f.logger.Debug("跳过学号嗅探", "reason", err)
			}
		}
		if cfg.FreshmanPlanWatchEnabled && f.dueFor("plan", interval) {
			if err := f.Start("plan", false); err != nil {
				f.logger.Debug("跳过培养方案嗅探", "reason", err)
			}
		}
	}
}

func (f *FreshmanService) dueFor(target string, interval time.Duration) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	last := f.probeOf(target).LastCheckedAt
	if last == "" {
		return true
	}
	at, err := time.Parse(time.RFC3339, last)
	return err != nil || time.Since(at) >= interval
}

// ------------------------------------------------------------- 学号名单扫描

// scanRoster walks colleges looking for classes of the target grade. A cheap
// check stops at the first such class per college — the question it answers is
// "has this cohort landed?", and one class per college answers it. A full sweep
// visits every class and writes the de-identified roster to disk.
func (f *FreshmanService) scanRoster(ctx context.Context, grade string, full bool) error {
	prefix := gradePrefix(grade)
	var rosters []FreshmanRoster
	var highlights []string
	scanned, found, failures, classesFound := 0, 0, 0, 0

	// 每一次网络往返各自抢一次锁，而不是整趟扫描占着不放：全量扫一遍要好几分钟，
	// 期间学号查询若被堵死，前台只会等到 Pages Function 超时然后回落到旧快照。
	// 翻页状态（__VIEWSTATE）是随响应带回来的字符串，握在我们手里，中途被别的查询
	// 插队不影响它。
	var page string
	var colleges []selectOption
	err := f.live.WithClient(ctx, func(client *JWCClient) (err error) {
		page, colleges, err = client.OpenCollegeMode(ctx)
		return err
	})
	if err != nil {
		return err
	}
	{
		f.update("roster", func(p *FreshmanProbe) {
			p.Total = len(colleges)
			p.Message = fmt.Sprintf("正在扫描 %d 个学院…", len(colleges))
		})
		for _, college := range colleges {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var classPage string
			var classes []FreshmanClass
			err := f.live.WithClient(ctx, func(client *JWCClient) (err error) {
				classPage, classes, err = client.ClassesOf(ctx, page, college)
				return err
			})
			if err != nil {
				failures++
				if failures >= freshmanMaxFailures {
					return fmt.Errorf("连续失败过多，已中止：%w", err)
				}
				continue
			}
			// 匹配的班级全部统计，但快速检查只**查**第一个。两者必须分开记：
			// 班级数是学校的事实（列表就在同一份响应里，白拿），抽查数是我们的
			// 采样口径。早先把「查了几个」当成「建了几个」写进面板，于是 23 个
			// 26 级班的人工智能学院被显示成「已建 1 个班」。
			matched := make([]FreshmanClass, 0, len(classes))
			for _, class := range classes {
				if strings.HasPrefix(class.ClassName, prefix) {
					matched = append(matched, class)
				}
			}
			classesFound += len(matched)
			probeList := matched
			if !full && len(probeList) > 1 {
				probeList = probeList[:1]
			}
			collegeFound := 0
			for _, class := range probeList {
				var ids []string
				err := f.live.WithClient(ctx, func(client *JWCClient) (err error) {
					ids, err = client.RosterOf(ctx, classPage, class)
					return err
				})
				scanned++
				if err != nil {
					failures++
					if failures >= freshmanMaxFailures {
						return fmt.Errorf("连续失败过多，已中止：%w", err)
					}
					continue
				}
				failures = 0
				collegeFound += len(ids)
				found += len(ids)
				if len(ids) > 0 && full {
					rosters = append(rosters, FreshmanRoster{class, ids})
				}
				f.update("roster", func(p *FreshmanProbe) {
					p.Scanned, p.Found = scanned, found
				})
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(freshmanSniffDelay):
				}
			}
			sampled := ""
			if len(probeList) < len(matched) {
				sampled = fmt.Sprintf("（抽查 %d 个）", len(probeList))
			}
			switch {
			case len(matched) == 0:
				highlights = append(highlights, college.Label+"：没有 "+prefix+" 班级")
			case collegeFound > 0:
				highlights = append(highlights, fmt.Sprintf("%s：%s%s %d 人", college.Label, plural(len(matched), " 个班"), sampled, collegeFound))
			default:
				highlights = append(highlights, fmt.Sprintf("%s：已建 %s%s，暂无名单", college.Label, plural(len(matched), " 个班"), sampled))
			}
		}
	}

	snapshot := ""
	if full && len(rosters) > 0 {
		snapshot = filepath.Join(filepath.Dir(f.env.ConfigPath), "freshman_roster_"+grade+".json")
		if err := WriteJSON(snapshot, rosters, 0o600); err != nil {
			return fmt.Errorf("写名单快照: %w", err)
		}
	}
	sort.Strings(highlights)
	// 「建了多少班」和「查了多少班」是两个数，面板上必须都给出来，否则抽查
	// 口径会被误读成学校的事实。
	scope := fmt.Sprintf("全校已建 %s %s，本次查了 %d 个", prefix, plural(classesFound, " 个班"), scanned)
	state, message := "waiting", scope+"，都还没有名单"
	if found > 0 {
		state = "found"
		message = fmt.Sprintf("%s，抓到学号 %d 个", scope, found)
		if !full {
			message += "（快速检查每个学院只抽查一个班，全量抓取会更多）"
		}
	}
	f.mu.Lock()
	f.state.Roster.Highlights = highlights
	if snapshot != "" {
		f.state.Roster.SnapshotPath = snapshot
	}
	f.mu.Unlock()
	f.end("roster", state, message, nil)
	return nil
}

// ImportRoster writes the last full sweep's 学号 into student_records.
//
// INSERT OR IGNORE 是刻意的：新生行只是占位（他们还没有课），而已经有快照的学号
// 绝不能被这行空记录盖掉。占位行进库之后，「固化学期」会在下一次跑到他们，把真
// 课表填进去。
func (f *FreshmanService) ImportRoster(ctx context.Context) (int, error) {
	f.mu.Lock()
	snapshot := f.state.Roster.SnapshotPath
	grade := f.state.Roster.Grade
	f.mu.Unlock()
	if snapshot == "" {
		return 0, errors.New("还没有全量名单快照，请先「全量抓取」")
	}
	var rosters []FreshmanRoster
	if err := readJSONFile(snapshot, &rosters); err != nil {
		return 0, fmt.Errorf("读名单快照: %w", err)
	}
	id := f.env.CFD1StudentsDatabaseID
	if id == "" {
		return 0, errors.New("未配置学号快照库（CF_D1_STUDENTS_DATABASE_ID），请在部署配置页填写")
	}
	client := f.clientFor().ForDatabase(id)
	if !client.D1Ready() {
		return 0, errors.New("Cloudflare D1 凭据未配置")
	}
	master, err := f.live.EnsureMaster()
	if err != nil {
		return 0, fmt.Errorf("加载课程主数据: %w", err)
	}

	written := 0
	var batch []D1Statement
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		writeCtx, cancel := context.WithTimeout(ctx, D1RequestTimeout)
		defer cancel()
		results := client.D1Many(writeCtx, batch)
		if err := firstD1Error(results); err != nil {
			return err
		}
		written += len(batch)
		batch = batch[:0]
		return nil
	}
	for _, roster := range rosters {
		planKey := classNameToPlanKey(roster.ClassName, master.ValidPlanKeys)
		for _, sid := range roster.StudentIDs {
			batch = append(batch, D1Statement{
				SQL: `INSERT OR IGNORE INTO student_records
				       (student_id, class_name, plan_key, total_earned, taken_count, record_json, updated_at)
				      VALUES (?,?,?,0,0,'',datetime('now'))`,
				Params: []any{sid, roster.ClassName, planKey},
			})
			if len(batch) >= 200 {
				if err := flush(); err != nil {
					return written, err
				}
			}
		}
	}
	if err := flush(); err != nil {
		return written, err
	}
	f.update("roster", func(p *FreshmanProbe) {
		p.ImportedAt = time.Now().UTC().Format(time.RFC3339)
		p.Imported = written
	})
	f.logger.Info("新生学号入库完成", "grade", grade, "rows", written)
	return written, nil
}

// ------------------------------------------------------------ 培养方案扫描

func (f *FreshmanService) scanPlan(ctx context.Context, grade string, full bool) error {
	var probes []PlanProbe
	var highlights []string
	scanned, found, failures := 0, 0, 0

	var page string
	var majors []selectOption
	err := f.live.WithClient(ctx, func(client *JWCClient) (err error) {
		page, majors, err = client.PlanMajors(ctx)
		return err
	})
	if err != nil {
		return err
	}
	{
		targets := majors
		if !full {
			targets = evenSample(majors, freshmanPlanSamples)
		}
		f.update("plan", func(p *FreshmanProbe) {
			p.Total = len(targets)
			p.Message = fmt.Sprintf("正在查 %d 个专业…", len(targets))
		})
		for _, major := range targets {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var probe PlanProbe
			err := f.live.WithClient(ctx, func(client *JWCClient) (err error) {
				probe, err = client.PlanOf(ctx, page, grade, major)
				return err
			})
			scanned++
			if err != nil {
				failures++
				if failures >= freshmanMaxFailures {
					return fmt.Errorf("连续失败过多，已中止：%w", err)
				}
				continue
			}
			failures = 0
			if probe.Courses > 0 {
				found++
				probes = append(probes, probe)
			}
			f.update("plan", func(p *FreshmanProbe) { p.Scanned, p.Found = scanned, found })
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(freshmanSniffDelay):
			}
		}
	}

	complete := 0
	for _, probe := range probes {
		if probe.HasGoal && probe.Natures >= 4 {
			complete++
		}
	}
	sort.Slice(probes, func(i, j int) bool { return probes[i].Courses > probes[j].Courses })
	for i, probe := range probes {
		if i >= 12 {
			break
		}
		mark := "部分"
		if probe.HasGoal && probe.Natures >= 4 {
			mark = "较完整"
		}
		highlights = append(highlights, fmt.Sprintf("%s：%d 门 / %d 类（%s）", probe.MajorName, probe.Courses, probe.Natures, mark))
	}

	snapshot := ""
	if full && len(probes) > 0 {
		snapshot = filepath.Join(filepath.Dir(f.env.ConfigPath), "freshman_plan_"+grade+".json")
		if err := WriteJSON(snapshot, probes, 0o600); err != nil {
			return fmt.Errorf("写方案摘要: %w", err)
		}
	}

	state, message := "waiting", fmt.Sprintf("查了 %d 个专业，%s级 还没有培养方案", scanned, grade[2:])
	if found > 0 {
		state = "found"
		message = fmt.Sprintf("查了 %d 个专业，%d 个已有课程，其中 %d 个看着较完整（有培养目标且性质≥4类）", scanned, found, complete)
		if complete == 0 {
			message += "；目前都还只是骨架，建议等铺齐再抓"
		}
	}
	f.mu.Lock()
	f.state.Plan.Highlights = highlights
	if snapshot != "" {
		f.state.Plan.SnapshotPath = snapshot
	}
	f.mu.Unlock()
	f.end("plan", state, message, nil)
	return nil
}

// evenSample picks n entries spread across the list, so a cheap check is not
// biased toward whichever majors happen to sort first.
func evenSample(values []selectOption, n int) []selectOption {
	if n <= 0 || len(values) <= n {
		return values
	}
	out := make([]selectOption, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, values[i*len(values)/n])
	}
	return out
}
