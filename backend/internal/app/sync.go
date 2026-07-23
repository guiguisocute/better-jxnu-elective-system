package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
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
	Semester        string `json:"semester,omitempty"`
	FormalSections  int    `json:"formalSections,omitempty"`
	CapacityVisible int    `json:"capacityVisible,omitempty"`
}

type SyncRunner struct {
	env        Environment
	config     *ConfigStore
	logger     *slog.Logger
	statusPath string
}

func NewSyncRunner(env Environment, config *ConfigStore, logger *slog.Logger) *SyncRunner {
	return &SyncRunner{env: env, config: config, logger: logger, statusPath: filepath.Join(filepath.Dir(env.ConfigPath), "last_sync.json")}
}
func (s *SyncRunner) Status() SyncStatus {
	var status SyncStatus
	if err := readJSONFile(s.statusPath, &status); err != nil {
		return SyncStatus{State: "never", Message: "尚未执行过同步"}
	}
	return status
}
func (s *SyncRunner) setStatus(status SyncStatus) {
	if err := WriteJSON(s.statusPath, status, 0o600); err != nil {
		s.logger.Error("写同步状态失败", "error", err)
	}
}
func (s *SyncRunner) Run(ctx context.Context) error {
	lock, err := tryFileLock(s.env.SyncLockPath)
	if err != nil {
		return err
	}
	defer lock.Close()
	cfg := s.config.Get()
	status := SyncStatus{State: "running", StartedAt: time.Now().UTC().Format(time.RFC3339), Message: "正在拉取教务数据", Semester: cfg.ScheduleSyncSemester}
	s.setStatus(status)
	fail := func(runErr error) error {
		status.State = "failed"
		status.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		status.Message = runErr.Error()
		s.setStatus(status)
		return runErr
	}
	if dirty, statusErr := s.command(ctx, 30*time.Second, "git", "status", "--porcelain"); statusErr != nil {
		return fail(statusErr)
	} else if strings.TrimSpace(dirty) != "" {
		return fail(errors.New("VPS 仓库存在未提交修改，已停止同步，避免覆盖人工改动"))
	}
	if _, err = s.command(ctx, 2*time.Minute, "git", "pull", "--ff-only", "origin", "main"); err != nil {
		return fail(fmt.Errorf("git pull --ff-only: %w", err))
	}
	semester := cfg.ScheduleSyncSemester
	rawPath := filepath.Join(s.env.RepoDir, "data", "semesters", semester, "raw", "formal_schedule.json")
	capacityPath := filepath.Join(s.env.RepoDir, "data", "semesters", semester, "raw", "xk_capacity.json")
	client := NewEnrollmentService(s.config, s.logger).client
	rows, err := FetchPublicSchedule(ctx, client)
	if err != nil {
		return fail(err)
	}
	if len(rows) < cfg.MinScheduleRows {
		return fail(fmt.Errorf("开课安排仅 %d 行，低于安全阈值 %d", len(rows), cfg.MinScheduleRows))
	}
	reused, missing := mergeScheduleEnrichment(rows, rawPath)
	s.logger.Info("复用开课 enrichment", "reused", reused, "missing", missing)
	if err = WriteJSON(rawPath, rows, 0o644); err != nil {
		return fail(err)
	}
	if cfg.CapacityEnabled && s.env.XKUsername != "" && s.env.XKPassword != "" {
		visibleProgress := 0
		snapshot, crawlErr := CrawlCapacity(ctx, NewXKClient(s.env.XKUsername, s.env.XKPassword), semester, rawPath, cfg.CapacityStep, time.Duration(cfg.CapacityDelayMilliseconds)*time.Millisecond, func(done, total int, record CapacityCourse) {
			if !record.Blocked {
				visibleProgress++
			}
			if done%100 == 0 || done == total {
				s.logger.Info("容量抓取进度", "done", done, "total", total, "visible", visibleProgress)
			}
		})
		if crawlErr != nil {
			s.logger.Warn("容量抓取失败，保留旧数据", "error", crawlErr)
		} else if snapshot.Summary.Visible < cfg.MinCapacityVisible {
			s.logger.Warn("容量可见数低于安全阈值，保留旧数据", "visible", snapshot.Summary.Visible, "minimum", cfg.MinCapacityVisible)
		} else {
			status.CapacityVisible = snapshot.Summary.Visible
			if err = WriteJSON(capacityPath, snapshot, 0o644); err != nil {
				return fail(err)
			}
		}
	}
	if _, err = s.command(ctx, 10*time.Minute, s.env.PythonExecutable, "build_data.py"); err != nil {
		s.rollback()
		return fail(fmt.Errorf("build_data.py: %w", err))
	}
	changed, err := s.commandExit(ctx, 30*time.Second, "git", "diff", "--quiet", "--", "public", "data/master")
	if err != nil {
		s.rollback()
		return fail(err)
	}
	if changed == 0 {
		_, _ = s.command(context.Background(), 30*time.Second, "git", "restore", "--worktree", "--", "data/semesters")
		status.State = "unchanged"
		status.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		status.Message = "数据没有变化，无需部署"
		s.setStatus(status)
		return nil
	}
	if changed != 1 {
		s.rollback()
		return fail(fmt.Errorf("git diff 返回异常状态 %d", changed))
	}
	sections, err := countJSONArray(filepath.Join(s.env.RepoDir, "public", "formal_sections.json"))
	if err != nil {
		s.rollback()
		return fail(err)
	}
	status.FormalSections = sections
	if sections < cfg.MinFormalSections {
		s.rollback()
		return fail(fmt.Errorf("formal_sections 仅 %d 条，低于安全阈值 %d", sections, cfg.MinFormalSections))
	}
	relRaw := filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw", "formal_schedule.json"))
	relCapacity := filepath.ToSlash(filepath.Join("data", "semesters", semester, "raw", "xk_capacity.json"))
	paths := []string{"public", relRaw, "data/master"}
	if _, statErr := os.Stat(capacityPath); statErr == nil {
		paths = append(paths, relCapacity)
	}
	if _, statErr := os.Stat(filepath.Join(s.env.RepoDir, "data", "build_config.json")); statErr == nil {
		paths = append(paths, "data/build_config.json")
	}
	args := append([]string{"add", "--"}, paths...)
	if _, err = s.command(ctx, 30*time.Second, "git", args...); err != nil {
		s.rollback()
		return fail(err)
	}
	message := fmt.Sprintf("data: Go 后端自动同步 %s (sections=%d)", semester, sections)
	if _, err = s.command(ctx, 30*time.Second, "git", "commit", "-m", message); err != nil {
		s.rollback()
		return fail(err)
	}
	if _, err = s.command(ctx, 2*time.Minute, "git", "push", "origin", "main"); err != nil {
		return fail(err)
	}
	status.State = "success"
	status.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	status.Message = "同步完成并已推送，Cloudflare Pages 将自动部署"
	s.setStatus(status)
	return nil
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
func (s *SyncRunner) commandExit(ctx context.Context, timeout time.Duration, name string, args ...string) (int, error) {
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, name, args...)
	cmd.Dir = s.env.RepoDir
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return -1, err
}
func (s *SyncRunner) rollback() {
	_, _ = s.command(context.Background(), time.Minute, "git", "restore", "--staged", "--worktree", "--", "public", "data/master", "data/semesters")
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
