package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

var errSyncBusy = errors.New("同步任务正在运行")

type SyncStatus struct {
	State           string `json:"state"`
	StartedAt       string `json:"startedAt,omitempty"`
	FinishedAt      string `json:"finishedAt,omitempty"`
	Message         string `json:"message"`
	DataSource      string `json:"dataSource,omitempty"`
	Semester        string `json:"semester,omitempty"`
	Courses         int    `json:"courses,omitempty"`
	FormalSections  int    `json:"formalSections,omitempty"`
	CapacityVisible int    `json:"capacityVisible,omitempty"`
	CourseDetails   int    `json:"courseDetails,omitempty"`
}

type SyncRunner struct {
	env        Environment
	config     *ConfigStore
	logger     *slog.Logger
	statusPath string
	watchPath  string
}

type AcquisitionWatchState struct {
	Schedules      map[string]FormalScheduleWatchState `json:"schedules,omitempty"`
	FormalSchedule FormalScheduleWatchState            `json:"formalSchedule,omitempty"` // v4 compatibility
}

type FormalScheduleWatchState struct {
	Semester    string `json:"semester,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Consecutive int    `json:"consecutive"`
	FirstSeenAt string `json:"firstSeenAt,omitempty"`
	LastSeenAt  string `json:"lastSeenAt,omitempty"`
}

type CourseDetailCommandResult struct {
	Path  string                   `json:"path"`
	Stats CourseDetailRefreshStats `json:"stats"`
}

type KKAPProbeResult struct {
	State          string   `json:"state"`
	Semester       string   `json:"semester"`
	AcademicTerm   string   `json:"academicTerm"`
	Rows           int      `json:"rows"`
	AvailableTerms []string `json:"availableTerms,omitempty"`
	Message        string   `json:"message"`
}

func NewSyncRunner(env Environment, config *ConfigStore, logger *slog.Logger) *SyncRunner {
	stateDir := filepath.Dir(env.ConfigPath)
	return &SyncRunner{
		env: env, config: config, logger: logger,
		statusPath: filepath.Join(stateDir, "last_sync.json"),
		watchPath:  filepath.Join(stateDir, "acquisition_watch.json"),
	}
}
func (s *SyncRunner) Status() SyncStatus {
	var status SyncStatus
	if err := readJSONFile(s.statusPath, &status); err != nil {
		return SyncStatus{State: "never", Message: "尚未执行过同步"}
	}
	return status
}

func (s *SyncRunner) ProbeKKAP(ctx context.Context, semester string) (KKAPProbeResult, error) {
	result := KKAPProbeResult{State: "checking", Semester: semester, AcademicTerm: academicTermLabel(semester)}
	rows, err := FetchPublicSchedule(ctx, NewEnrollmentService(s.config, s.logger).client, semester)
	if err != nil {
		var unavailable *TargetSemesterUnavailableError
		if errors.As(err, &unavailable) {
			result.State = "waiting"
			result.AvailableTerms = unavailable.AvailableTerms
			result.Message = unavailable.Error()
			return result, nil
		}
		var incomplete *TargetScheduleIncompleteError
		if errors.As(err, &incomplete) {
			result.State = "waiting"
			result.Message = incomplete.Error()
			return result, nil
		}
		return result, err
	}
	result.State = "available"
	result.Rows = len(rows)
	result.Message = fmt.Sprintf("目标学期已开放并通过逐行学期校验，共 %d 行", len(rows))
	return result, nil
}

func (s *SyncRunner) RefreshCourseDetailsOnly(ctx context.Context) (CourseDetailCommandResult, error) {
	cfg := s.config.Get()
	profile := cfg.ActiveAcquisitionProfile()
	if !profile.CourseDetailsEnabled {
		return CourseDetailCommandResult{}, errors.New("预选目录不是教学班课表；请切换到正选/补退选入口后再核查课程详情")
	}
	if s.env.XKUsername == "" || s.env.XKPassword == "" {
		return CourseDetailCommandResult{}, errors.New("未配置教务账号，无法核查课程详情")
	}
	semester := profile.Semester
	rawPath := filepath.Join(s.env.RepoDir, "data", "semesters", semester, "raw", profile.RawFilename)
	detailPath := filepath.Join(s.env.RepoDir, "data", "semesters", semester, "raw", "course_details.json")
	var rows []ScheduleRow
	if err := readJSONFile(rawPath, &rows); err != nil {
		return CourseDetailCommandResult{}, fmt.Errorf("读取开课安排: %w", err)
	}
	var old CourseDetailSnapshot
	_ = readJSONFile(detailPath, &old)
	details, stats := RefreshCourseDetails(ctx, NewJWCClient(s.env.XKUsername, s.env.XKPassword), semester, rows, old, cfg, s.logger)
	if stats.Updated+stats.Refreshed > 0 {
		if err := WriteJSON(detailPath, details, 0o644); err != nil {
			return CourseDetailCommandResult{}, err
		}
	}
	return CourseDetailCommandResult{Path: detailPath, Stats: stats}, nil
}
func (s *SyncRunner) setStatus(status SyncStatus) {
	if err := WriteJSON(s.statusPath, status, 0o600); err != nil {
		s.logger.Error("写同步状态失败", "error", err)
	}
}
func (s *SyncRunner) Run(ctx context.Context, scheduled bool) error {
	return s.run(ctx, scheduled, true)
}

func (s *SyncRunner) BuildOnly(ctx context.Context) error {
	return s.run(ctx, false, false)
}

func (s *SyncRunner) run(ctx context.Context, scheduled, acquire bool) error {
	cfg := s.config.Get()
	profile := cfg.ActiveAcquisitionProfile()
	if scheduled && !s.scheduledDue(cfg, time.Now()) {
		return nil
	}
	lock, err := tryFileLock(s.env.SyncLockPath)
	if err != nil {
		return err
	}
	defer lock.Close()
	message := "正在拉取教务数据"
	if !acquire {
		message = "正在使用现有 raw 离线构建"
	}
	status := SyncStatus{State: "running", StartedAt: time.Now().UTC().Format(time.RFC3339), Message: message, DataSource: profile.DataSource, Semester: profile.Semester}
	s.setStatus(status)
	fail := func(runErr error) error {
		status.State = "failed"
		status.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		status.Message = runErr.Error()
		s.setStatus(status)
		return runErr
	}
	semester := profile.Semester
	manualPaths := []string{}
	if dirty, statusErr := s.command(ctx, 30*time.Second, "git", "status", "--porcelain"); statusErr != nil {
		return fail(statusErr)
	} else if strings.TrimSpace(dirty) != "" {
		if acquire {
			return fail(errors.New("VPS 仓库存在未提交修改，已停止同步，避免覆盖人工改动"))
		}
		manualPaths, err = allowedManualRawChanges(dirty, semester)
		if err != nil {
			return fail(err)
		}
		s.logger.Info("检测到允许的手工 raw，离线构建将保留并发布", "paths", manualPaths)
	} else {
		if _, err = s.command(ctx, 2*time.Minute, "git", "pull", "--ff-only", "origin", "main"); err != nil {
			return fail(fmt.Errorf("git pull --ff-only: %w", err))
		}
	}
	rawPath := filepath.Join(s.env.RepoDir, "data", "semesters", semester, "raw", profile.RawFilename)
	metaPath := filepath.Join(s.env.RepoDir, "data", "semesters", semester, "meta.json")
	capacityPath := ""
	if profile.CapacityFilename != "" {
		capacityPath = filepath.Join(s.env.RepoDir, "data", "semesters", semester, "raw", profile.CapacityFilename)
	}
	detailPath := filepath.Join(s.env.RepoDir, "data", "semesters", semester, "raw", "course_details.json")
	var rows []ScheduleRow
	sourceAvailable := false
	watchWaiting := ""
	metadataPaths := []string{}
	if acquire {
		if profile.DataSource == "pre" {
			var count int
			count, sourceAvailable, watchWaiting, err = acquirePreselectCatalog(rawPath, semester, scheduled)
			status.Courses = count
			if err == nil && sourceAvailable {
				metadataPaths, err = ensurePreselectCurrentMeta(s.env.RepoDir, semester)
			}
		} else {
			rows, sourceAvailable, watchWaiting, err = s.acquireSchedule(ctx, cfg, profile, scheduled, rawPath, metaPath)
		}
		if err != nil {
			return fail(err)
		}
	} else {
		s.logger.Info("离线构建模式：跳过所有联网采集", "dataSource", profile.DataSource, "semester", semester)
		if profile.DataSource == "pre" {
			var count int
			count, sourceAvailable, _, err = acquirePreselectCatalog(rawPath, semester, false)
			status.Courses = count
			if err == nil && sourceAvailable {
				metadataPaths, err = ensurePreselectCurrentMeta(s.env.RepoDir, semester)
			}
			if err != nil {
				return fail(err)
			}
		}
	}
	if acquire && sourceAvailable && profile.CourseDetailsEnabled && cfg.CourseDetailsEnabled && s.env.XKUsername != "" && s.env.XKPassword != "" && buildSupportsCourseDetails(s.env.RepoDir) {
		var oldDetails CourseDetailSnapshot
		_ = readJSONFile(detailPath, &oldDetails)
		details, detailStats := RefreshCourseDetails(ctx, NewJWCClient(s.env.XKUsername, s.env.XKPassword), semester, rows, oldDetails, cfg, s.logger)
		status.CourseDetails = detailsCount(details)
		s.logger.Info("课程详情核查完成", "candidates", detailStats.Candidates, "attempted", detailStats.Attempted, "updated", detailStats.Updated, "refreshed", detailStats.Refreshed, "unchanged", detailStats.Unchanged, "failed", detailStats.Failed, "cached", detailStats.Cached)
		if detailStats.Updated+detailStats.Refreshed > 0 {
			if err = WriteJSON(detailPath, details, 0o644); err != nil {
				return fail(err)
			}
		}
	} else if acquire && sourceAvailable && profile.CourseDetailsEnabled && cfg.CourseDetailsEnabled && !buildSupportsCourseDetails(s.env.RepoDir) {
		s.logger.Warn("远端 build_data.py 尚未支持 course_details，暂跳过详情核查，避免产生无法消费的 raw")
	}
	if acquire && sourceAvailable && profile.CapacityEnabled && s.env.XKUsername != "" && s.env.XKPassword != "" {
		visibleProgress := 0
		snapshot, crawlErr := CrawlCapacity(ctx, NewXKClient(s.env.XKUsername, s.env.XKPassword), semester, rawPath, profile.CapacityURL, time.Duration(cfg.CapacityDelayMilliseconds)*time.Millisecond, func(done, total int, record CapacityCourse) {
			if !record.Blocked {
				visibleProgress++
			}
			if done%100 == 0 || done == total {
				s.logger.Info("容量抓取进度", "done", done, "total", total, "visible", visibleProgress)
			}
		})
		if crawlErr != nil {
			s.logger.Warn("容量抓取失败，保留旧数据", "error", crawlErr)
		} else if snapshot.Summary.Visible < profile.MinCapacityVisible {
			s.logger.Warn("容量可见数低于阶段安全阈值，保留旧数据", "dataSource", profile.DataSource, "visible", snapshot.Summary.Visible, "minimum", profile.MinCapacityVisible)
		} else {
			status.CapacityVisible = snapshot.Summary.Visible
			if err = WriteJSON(capacityPath, snapshot, 0o644); err != nil {
				return fail(err)
			}
		}
	}
	if _, err = s.command(ctx, 10*time.Minute, s.env.PythonExecutable, "build_data.py"); err != nil {
		s.rollback(acquire, semester)
		return fail(fmt.Errorf("build_data.py: %w", err))
	}
	relRaw := filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw", profile.RawFilename))
	relMeta := filepath.ToSlash(filepath.Join("data", "semesters", semester, "meta.json"))
	relDetail := filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw", "course_details.json"))
	relCapacity := ""
	if profile.CapacityFilename != "" {
		relCapacity = filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw", profile.CapacityFilename))
	}
	changePaths := []string{"public", "data/master", relRaw, relMeta, relDetail, "data/build_config.json"}
	changePaths = appendUniquePaths(changePaths, relCapacity)
	changePaths = appendUniquePaths(changePaths, metadataPaths...)
	changePaths = appendUniquePaths(changePaths, manualPaths...)
	statusArgs := append([]string{"status", "--porcelain", "--"}, changePaths...)
	changed, err := s.command(ctx, 30*time.Second, "git", statusArgs...)
	if err != nil {
		s.rollback(acquire, semester)
		return fail(err)
	}
	if strings.TrimSpace(changed) == "" {
		_, _ = s.command(context.Background(), 30*time.Second, "git", "restore", "--worktree", "--", "data/semesters")
		status.State = "unchanged"
		status.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		status.Message = "数据没有变化，无需部署"
		if watchWaiting != "" {
			status.State = "waiting"
			status.Message = watchWaiting
		}
		s.setStatus(status)
		return nil
	}
	sections := 0
	if profile.DataSource != "pre" {
		sections, err = countSectionsForSemester(filepath.Join(s.env.RepoDir, "public", "formal_sections.json"), semester)
		if err != nil {
			s.rollback(acquire, semester)
			return fail(err)
		}
	}
	status.FormalSections = sections
	if profile.DataSource == "pre" {
		status.Courses, err = countJSONArray(filepath.Join(s.env.RepoDir, "public", "courses.json"))
		if err != nil || status.Courses == 0 {
			s.rollback(acquire, semester, profile)
			if err != nil {
				return fail(err)
			}
			return fail(errors.New("预选 public/courses.json 为空；请确认目标学期 meta.isCurrent 与 preselect_catalog.json"))
		}
	} else if sections < profile.MinSections {
		s.rollback(acquire, semester, profile)
		return fail(fmt.Errorf("%s %s 的教学班产物仅 %d 条，低于安全阈值 %d", profile.Label, semester, sections, profile.MinSections))
	}
	paths := []string{"public", "data/master"}
	paths = appendUniquePaths(paths, manualPaths...)
	paths = appendUniquePaths(paths, metadataPaths...)
	if _, statErr := os.Stat(rawPath); statErr == nil {
		paths = appendUniquePaths(paths, relRaw)
	}
	if _, statErr := os.Stat(metaPath); statErr == nil {
		paths = append(paths, relMeta)
	}
	if profile.CourseDetailsEnabled {
		if _, statErr := os.Stat(detailPath); statErr == nil {
			paths = append(paths, relDetail)
		}
	}
	if capacityPath != "" {
		if _, statErr := os.Stat(capacityPath); statErr == nil {
			paths = append(paths, relCapacity)
		}
	}
	if _, statErr := os.Stat(filepath.Join(s.env.RepoDir, "data", "build_config.json")); statErr == nil {
		paths = append(paths, "data/build_config.json")
	}
	args := append([]string{"add", "--"}, paths...)
	if _, err = s.command(ctx, 30*time.Second, "git", args...); err != nil {
		s.rollback(acquire, semester)
		return fail(err)
	}
	metric := fmt.Sprintf("sections=%d", sections)
	if profile.DataSource == "pre" {
		metric = fmt.Sprintf("courses=%d", status.Courses)
	}
	commitMessage := fmt.Sprintf("data: Go 后端自动同步%s %s (%s)", profile.Label, semester, metric)
	if !acquire {
		commitMessage = fmt.Sprintf("data: 构建%s raw %s (%s)", profile.Label, semester, metric)
	}
	if _, err = s.command(ctx, 30*time.Second, "git", "commit", "-m", commitMessage); err != nil {
		s.rollback(acquire, semester)
		return fail(err)
	}
	if _, err = s.command(ctx, 2*time.Minute, "git", "push", "origin", "main"); err != nil {
		return fail(err)
	}
	status.State = "success"
	status.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	status.Message = "同步完成并已推送，Cloudflare Pages 将自动部署"
	if watchWaiting != "" {
		status.Message += "；" + watchWaiting
	}
	s.setStatus(status)
	return nil
}

func (s *SyncRunner) acquireSchedule(ctx context.Context, cfg RuntimeConfig, profile AcquisitionProfile, scheduled bool, rawPath, metaPath string) ([]ScheduleRow, bool, string, error) {
	semester := profile.Semester
	if !profile.KKAPEnabled {
		var rows []ScheduleRow
		if err := readJSONFile(rawPath, &rows); err != nil {
			if scheduled && errors.Is(err, os.ErrNotExist) {
				message := fmt.Sprintf("%s联网采集未启用，等待手工 raw：data/semesters/%s/raw/%s", profile.Label, semester, profile.RawFilename)
				return nil, false, message, nil
			}
			return nil, false, "", fmt.Errorf("%s联网采集未启用，读取手工课表: %w", profile.Label, err)
		}
		s.logger.Info("阶段联网采集未启用，使用现有手工 raw", "dataSource", profile.DataSource, "semester", semester, "rows", len(rows))
		return rows, true, "", nil
	}

	rows, err := FetchPublicSchedule(ctx, NewEnrollmentService(s.config, s.logger).client, semester)
	if err != nil {
		var unavailable *TargetSemesterUnavailableError
		if errors.As(err, &unavailable) {
			s.logger.Info("KKAP 目标学期尚未开放，继续待命", "semester", semester, "academicTerm", unavailable.TargetTerm, "availableTerms", unavailable.AvailableTerms)
			return nil, false, unavailable.Error(), nil
		}
		var incomplete *TargetScheduleIncompleteError
		if scheduled && errors.As(err, &incomplete) {
			s.logger.Info("KKAP 目标学期已出现但课表尚未完整，继续待命", "semester", semester, "academicTerm", incomplete.TargetTerm, "reason", incomplete.Cause)
			return nil, false, incomplete.Error(), nil
		}
		return nil, false, "", err
	}
	if len(rows) < profile.MinScheduleRows {
		if scheduled {
			message := fmt.Sprintf("已发现 %s（%s），但%s开课安排只有 %d 行，低于安全阈值 %d；继续待命", academicTermLabel(semester), semester, profile.Label, len(rows), profile.MinScheduleRows)
			return nil, false, message, nil
		}
		return nil, false, "", fmt.Errorf("%s开课安排仅 %d 行，低于安全阈值 %d", profile.Label, len(rows), profile.MinScheduleRows)
	}
	// A structurally identical raw file has already passed the safety gate in a
	// previous run/deployment. Treat it as stable immediately; only a genuinely
	// new or changed target must be observed in consecutive scheduled checks.
	alreadyAccepted := formalScheduleFileMatches(rawPath, rows)
	ready, passes, err := s.noteScheduleCandidate(rows, profile.DataSource, semester, cfg.FormalScheduleStableChecks, !scheduled || alreadyAccepted)
	if err != nil {
		return nil, false, "", err
	}
	if !ready {
		message := fmt.Sprintf("已发现 %s（%s），结构校验 %d/%d；继续待命，确认稳定后再写入 raw", academicTermLabel(semester), semester, passes, cfg.FormalScheduleStableChecks)
		s.logger.Info("KKAP 目标学期已出现，等待连续稳定", "semester", semester, "passes", passes, "required", cfg.FormalScheduleStableChecks, "rows", len(rows))
		return nil, false, message, nil
	}
	reused, missing := mergeScheduleEnrichment(rows, rawPath)
	s.logger.Info("复用开课 enrichment", "reused", reused, "missing", missing)
	if err = ensureSemesterMeta(metaPath, semester); err != nil {
		return nil, false, "", err
	}
	if alreadyAccepted {
		s.logger.Info("KKAP 课表结构未变化，忽略仅授课人数或序号变化", "semester", semester, "rows", len(rows))
	} else if err = WriteJSON(rawPath, rows, 0o644); err != nil {
		return nil, false, "", err
	}
	return rows, true, "", nil
}

func acquirePreselectCatalog(rawPath, semester string, scheduled bool) (int, bool, string, error) {
	count, err := countJSONArray(rawPath)
	if err == nil {
		if count == 0 {
			return 0, false, "", errors.New("预选目录为空，拒绝构建")
		}
		return count, true, "", nil
	}
	if scheduled && errors.Is(err, os.ErrNotExist) {
		message := fmt.Sprintf("预选系统关闭或采集契约尚未验证，等待手工 raw：data/semesters/%s/raw/preselect_catalog.json", semester)
		return 0, false, message, nil
	}
	return 0, false, "", fmt.Errorf("读取预选课程目录: %w", err)
}

// ensurePreselectCurrentMeta makes the selected preselect target the catalog
// source consumed by build_data.py. Formal/add-drop targets never call this and
// therefore cannot silently switch the site's preselect semester.
func ensurePreselectCurrentMeta(repoDir, semester string) ([]string, error) {
	paths, err := filepath.Glob(filepath.Join(repoDir, "data", "semesters", "*", "meta.json"))
	if err != nil {
		return nil, err
	}
	targetPath := filepath.Join(repoDir, "data", "semesters", semester, "meta.json")
	foundTarget := false
	changed := []string{}
	for _, path := range paths {
		var meta map[string]any
		if err := readJSONFile(path, &meta); err != nil {
			return nil, fmt.Errorf("读取学期 meta %s: %w", path, err)
		}
		isTarget := filepath.Clean(path) == filepath.Clean(targetPath)
		if isTarget {
			foundTarget = true
		}
		current, _ := meta["isCurrent"].(bool)
		if current == isTarget {
			continue
		}
		meta["isCurrent"] = isTarget
		if isTarget {
			meta["label"] = semester
		}
		if err := WriteJSON(path, meta, 0o644); err != nil {
			return nil, err
		}
		changed = append(changed, relativeRepoPath(repoDir, path))
	}
	if !foundTarget {
		meta := map[string]any{
			"label": semester, "isCurrent": true,
			"fetchedAt": time.Now().UTC().Format(time.RFC3339),
			"note":      "由 Go 后端按预选目标创建；preselect_catalog.json 仍来自已验证的手工/CAS 采集。",
		}
		if err := WriteJSON(targetPath, meta, 0o644); err != nil {
			return nil, err
		}
		changed = append(changed, relativeRepoPath(repoDir, targetPath))
	}
	sort.Strings(changed)
	return changed, nil
}

func relativeRepoPath(repoDir, path string) string {
	rel, err := filepath.Rel(repoDir, path)
	if err != nil {
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(rel)
}

func (s *SyncRunner) scheduledDue(cfg RuntimeConfig, now time.Time) bool {
	if !cfg.AutoSyncEnabled {
		s.logger.Info("自动构建已关闭，跳过本轮 timer")
		return false
	}
	status := s.Status()
	last := status.StartedAt
	if last == "" {
		last = status.FinishedAt
	}
	if parsed, err := time.Parse(time.RFC3339, last); err == nil && now.Sub(parsed) < time.Duration(cfg.AutoSyncIntervalMinutes)*time.Minute {
		s.logger.Info("自动构建尚未到间隔，跳过本轮 timer", "intervalMinutes", cfg.AutoSyncIntervalMinutes)
		return false
	}
	return true
}

func (s *SyncRunner) noteScheduleCandidate(rows []ScheduleRow, dataSource, semester string, required int, force bool) (bool, int, error) {
	fingerprint := formalScheduleFingerprint(rows)
	now := time.Now().UTC().Format(time.RFC3339)
	var state AcquisitionWatchState
	_ = readJSONFile(s.watchPath, &state)
	if state.Schedules == nil {
		state.Schedules = map[string]FormalScheduleWatchState{}
	}
	watch := state.Schedules[dataSource]
	if watch.Semester == "" && dataSource == "formal" {
		watch = state.FormalSchedule
	}
	if watch.Semester != semester || watch.Fingerprint != fingerprint {
		watch = FormalScheduleWatchState{
			Semester: semester, Fingerprint: fingerprint, Consecutive: 1,
			FirstSeenAt: now, LastSeenAt: now,
		}
	} else {
		watch.LastSeenAt = now
		if watch.Consecutive < required {
			watch.Consecutive++
		}
	}
	if force && watch.Consecutive < required {
		watch.Consecutive = required
	}
	state.Schedules[dataSource] = watch
	state.FormalSchedule = FormalScheduleWatchState{}
	if err := WriteJSON(s.watchPath, state, 0o600); err != nil {
		return false, watch.Consecutive, fmt.Errorf("保存采集待命状态: %w", err)
	}
	return watch.Consecutive >= required, watch.Consecutive, nil
}

func formalScheduleFingerprint(rows []ScheduleRow) string {
	values := make([]string, 0, len(rows))
	for _, row := range rows {
		// 授课人数会实时变化，不属于课表结构；序号也可能仅因页面排序变化而改变。
		values = append(values, strings.Join([]string{
			row.Department, row.CourseID, row.CourseName, row.ClassID, row.ClassName,
			strings.TrimSpace(row.Teacher), row.Classroom, row.Weekday, row.Period, row.RawSemester,
		}, "\x00"))
	}
	sort.Strings(values)
	sum := sha256.Sum256([]byte(strings.Join(values, "\n")))
	return fmt.Sprintf("%x", sum[:])
}

func formalScheduleFileMatches(path string, rows []ScheduleRow) bool {
	var old []ScheduleRow
	if err := readJSONFile(path, &old); err != nil {
		return false
	}
	return formalScheduleFingerprint(old) == formalScheduleFingerprint(rows)
}

func ensureSemesterMeta(path, semester string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	meta := map[string]any{
		"label":     semester,
		"fetchedAt": time.Now().UTC().Format(time.RFC3339),
		"isCurrent": false,
		"note":      "由 Go 后端按目标教务学期自动创建；仅抓到正式开课安排，不自动切换预选当前学期。",
	}
	return WriteJSON(path, meta, 0o644)
}

func academicTermLabel(semester string) string {
	if term, ok := AcademicTermFromSemester(semester); ok {
		return term
	}
	return semester
}

func detailsCount(snapshot CourseDetailSnapshot) int { return len(snapshot.Courses) }

func buildSupportsCourseDetails(repoDir string) bool {
	raw, err := os.ReadFile(filepath.Join(repoDir, "build_data.py"))
	return err == nil && bytes.Contains(raw, []byte(`"course_details"`))
}

func (s *SyncRunner) command(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, name, args...)
	cmd.Dir = s.env.RepoDir
	cmd.Env = os.Environ()
	if s.env.GitSSHCommand != "" {
		cmd.Env = append(cmd.Env, "GIT_SSH_COMMAND="+s.env.GitSSHCommand)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if commandCtx.Err() != nil {
		return stdout.String(), fmt.Errorf("命令超时: %s %s", name, strings.Join(args, " "))
	}
	if err != nil {
		return stdout.String(), fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	if text := strings.TrimSpace(stdout.String()); text != "" {
		s.logger.Info("命令输出", "command", name, "output", truncate(text, 2000))
	}
	return stdout.String(), nil
}
func (s *SyncRunner) rollback(includeAcquiredRaw bool, semester string, profiles ...AcquisitionProfile) {
	profile := s.config.Get().ActiveAcquisitionProfile()
	if len(profiles) > 0 {
		profile = profiles[0]
	}
	paths := []string{"public", "data/master"}
	if includeAcquiredRaw {
		paths = append(paths, "data/semesters")
	}
	args := append([]string{"restore", "--staged", "--worktree", "--"}, paths...)
	_, _ = s.command(context.Background(), time.Minute, "git", args...)
	if includeAcquiredRaw {
		// 采集任务开始前强制要求仓库完全干净，因此这里出现的未跟踪目标文件
		// 只能由本轮任务创建。仅删除本阶段的精确文件，不递归删除目录。
		candidates := []string{
			filepath.ToSlash(filepath.Join("data", "semesters", semester, "meta.json")),
			filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw", profile.RawFilename)),
			filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw", "course_details.json")),
		}
		if profile.CapacityFilename != "" {
			candidates = append(candidates, filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw", profile.CapacityFilename)))
		}
		for _, relative := range candidates {
			state, _ := s.command(context.Background(), 30*time.Second, "git", "status", "--porcelain", "--", relative)
			if strings.HasPrefix(strings.TrimSpace(state), "??") {
				_ = os.Remove(filepath.Join(s.env.RepoDir, filepath.FromSlash(relative)))
			}
		}
	}
	if !includeAcquiredRaw {
		// 手工 raw 是操作者的输入。失败时只取消暂存，绝不还原工作区内容。
		_, _ = s.command(context.Background(), time.Minute, "git", "restore", "--staged", "--", "data/semesters", "data/master_raw")
	}
}

func allowedManualRawChanges(porcelain, semester string) ([]string, error) {
	prefix := filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw")) + "/"
	meta := filepath.ToSlash(filepath.Join("data", "semesters", semester, "meta.json"))
	allowed := map[string]bool{}
	for _, line := range strings.Split(strings.TrimRight(porcelain, "\r\n"), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if len(line) < 4 || strings.Contains(line, " -> ") {
			return nil, errors.New("离线构建检测到无法识别的 Git 改动")
		}
		path := strings.TrimSpace(line[3:])
		path = filepath.ToSlash(strings.Trim(path, `"`))
		isSemesterRaw := strings.HasPrefix(path, prefix) && strings.HasSuffix(strings.ToLower(path), ".json")
		isMasterRaw := path == "data/master_raw/training_plan.json"
		if !isSemesterRaw && path != meta && !isMasterRaw {
			return nil, fmt.Errorf("离线构建只允许目标学期 raw / meta 或 training_plan.json 存在未提交改动；发现：%s", path)
		}
		allowed[path] = true
	}
	paths := make([]string, 0, len(allowed))
	for path := range allowed {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths, nil
}

func appendUniquePaths(paths []string, more ...string) []string {
	seen := make(map[string]bool, len(paths)+len(more))
	for _, path := range paths {
		seen[path] = true
	}
	for _, path := range more {
		if path != "" && !seen[path] {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	return paths
}
func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max] + "…"
}
func countJSONArray(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	var values []json.RawMessage
	if err = json.NewDecoder(file).Decode(&values); err != nil {
		return 0, err
	}
	return len(values), nil
}

func countSectionsForSemester(path, semester string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	var values []struct {
		Semester string `json:"semester"`
	}
	if err = json.NewDecoder(file).Decode(&values); err != nil {
		return 0, err
	}
	count := 0
	for _, value := range values {
		if value.Semester == semester {
			count++
		}
	}
	return count, nil
}

func mergeScheduleEnrichment(rows []ScheduleRow, oldPath string) (int, int) {
	var old []ScheduleRow
	if err := readJSONFile(oldPath, &old); err != nil {
		return 0, len(rows)
	}
	index := map[string]ScheduleRow{}
	for _, row := range old {
		key := row.CourseID + "\x00" + row.ClassID + "\x00" + strings.TrimSpace(row.Teacher)
		if _, ok := index[key]; !ok && (row.CatalogID != nil || row.CourseInfo != nil || row.TeacherInfo != nil) {
			index[key] = row
		}
	}
	reused, missing := 0, 0
	for i := range rows {
		key := rows[i].CourseID + "\x00" + rows[i].ClassID + "\x00" + strings.TrimSpace(rows[i].Teacher)
		if source, ok := index[key]; ok {
			rows[i].CatalogID = source.CatalogID
			rows[i].CourseInfo = source.CourseInfo
			rows[i].TeacherInfo = source.TeacherInfo
			reused++
		} else {
			missing++
		}
	}
	return reused, missing
}

func ParseSyncStatus(raw []byte) SyncStatus {
	var status SyncStatus
	if json.Unmarshal(raw, &status) != nil {
		return SyncStatus{State: "unknown", Message: "状态文件损坏"}
	}
	return status
}
func atoiDefault(value string, fallback int) int {
	n, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return n
}
