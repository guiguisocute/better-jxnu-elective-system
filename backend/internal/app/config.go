package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultPublicAddr = "127.0.0.1:8787"
	DefaultLiveAddr   = "127.0.0.1:8788"
	DefaultAdminAddr  = "127.0.0.1:8790"
)

var (
	semesterPattern = regexp.MustCompile(`^\d{4}-(03|09)$`)
	termPattern     = regexp.MustCompile(`^\d{2}-\d{2}第\d{1,2}学期$`)
)

// RuntimeConfig contains the ordinary operational choices that should take
// effect immediately. Secrets stay in the systemd EnvironmentFile.
type RuntimeConfig struct {
	Version                            int      `json:"version"`
	DefaultDataSource                  string   `json:"defaultDataSource"`
	LiveEnrollmentSemester             string   `json:"liveEnrollmentSemester"`
	ScheduleSyncSemester               string   `json:"scheduleSyncSemester"`
	StudentScheduleTerm                string   `json:"studentScheduleTerm"`
	EnrollmentRefreshSeconds           int      `json:"enrollmentRefreshSeconds"`
	StudentCacheSeconds                int      `json:"studentCacheSeconds"`
	CapacityEnabled                    bool     `json:"capacityEnabled"`
	CapacityStep                       string   `json:"capacityStep"`
	CapacityDelayMilliseconds          int      `json:"capacityDelayMilliseconds"`
	MinScheduleRows                    int      `json:"minScheduleRows"`
	MinFormalSections                  int      `json:"minFormalSections"`
	MinCapacityVisible                 int      `json:"minCapacityVisible"`
	AllowedOrigins                     []string `json:"allowedOrigins"`
	AutoSyncEnabled                    bool     `json:"autoSyncEnabled"`
	AutoSyncIntervalMinutes            int      `json:"autoSyncIntervalMinutes"`
	CourseDetailsEnabled               bool     `json:"courseDetailsEnabled"`
	CourseDetailsVerifyTrackedEveryRun bool     `json:"courseDetailsVerifyTrackedEveryRun"`
	CourseDetailsRefreshHours          int      `json:"courseDetailsRefreshHours"`
	CourseDetailsMaxPerRun             int      `json:"courseDetailsMaxPerRun"`
	CourseDetailsDelayMilliseconds     int      `json:"courseDetailsDelayMilliseconds"`
	CourseDetailCourseIDs              []string `json:"courseDetailCourseIds"`
}

func DefaultRuntimeConfig() RuntimeConfig {
	return RuntimeConfig{
		Version:                            1,
		DefaultDataSource:                  "formal",
		LiveEnrollmentSemester:             "2026-09",
		ScheduleSyncSemester:               "2026-09",
		StudentScheduleTerm:                "",
		EnrollmentRefreshSeconds:           30,
		StudentCacheSeconds:                600,
		CapacityEnabled:                    false,
		CapacityStep:                       "Step3",
		CapacityDelayMilliseconds:          100,
		MinScheduleRows:                    6000,
		MinFormalSections:                  7000,
		MinCapacityVisible:                 300,
		AutoSyncEnabled:                    true,
		AutoSyncIntervalMinutes:            60,
		CourseDetailsEnabled:               true,
		CourseDetailsVerifyTrackedEveryRun: true,
		CourseDetailsRefreshHours:          168,
		CourseDetailsMaxPerRun:             30,
		CourseDetailsDelayMilliseconds:     300,
		CourseDetailCourseIDs: []string{
			"252599", "255006", "255301", "255543", "259772", "259773", "262572", "264683", "266336",
		},
		AllowedOrigins: []string{
			"https://xk.jxnu-publish.asia",
			"https://test.better-jxnu-elective-system.pages.dev",
			"http://localhost:5173",
			"http://127.0.0.1:5173",
		},
	}
}

func (c RuntimeConfig) Validate() error {
	if c.Version != 1 {
		return fmt.Errorf("不支持的配置版本 %d", c.Version)
	}
	if c.DefaultDataSource != "pre" && c.DefaultDataSource != "formal" && c.DefaultDataSource != "addDrop" {
		return errors.New("默认选课阶段必须是 pre、formal 或 addDrop")
	}
	for label, value := range map[string]string{
		"实时人数学期": c.LiveEnrollmentSemester,
		"自动同步学期": c.ScheduleSyncSemester,
	} {
		if !semesterPattern.MatchString(value) {
			return fmt.Errorf("%s必须是 YYYY-03 或 YYYY-09", label)
		}
	}
	if c.StudentScheduleTerm != "" && !termPattern.MatchString(c.StudentScheduleTerm) {
		return errors.New("学号课表学期必须类似 26-27第1学期，留空表示自动跟随教务")
	}
	if c.EnrollmentRefreshSeconds < 10 || c.EnrollmentRefreshSeconds > 3600 {
		return errors.New("实时人数刷新间隔须为 10–3600 秒")
	}
	if c.StudentCacheSeconds < 0 || c.StudentCacheSeconds > 86400 {
		return errors.New("学号缓存须为 0–86400 秒")
	}
	if !regexp.MustCompile(`^Step[1-9]$`).MatchString(c.CapacityStep) {
		return errors.New("容量阶段须为 Step1–Step9")
	}
	if c.CapacityDelayMilliseconds < 0 || c.CapacityDelayMilliseconds > 10000 {
		return errors.New("容量请求间隔须为 0–10000 毫秒")
	}
	if c.MinScheduleRows < 1 || c.MinFormalSections < 1 || c.MinCapacityVisible < 0 {
		return errors.New("同步安全阈值不合法")
	}
	if c.AutoSyncIntervalMinutes < 15 || c.AutoSyncIntervalMinutes > 1440 {
		return errors.New("自动构建间隔须为 15–1440 分钟")
	}
	if c.CourseDetailsRefreshHours < 1 || c.CourseDetailsRefreshHours > 24*365 {
		return errors.New("课程详情普通缓存周期须为 1–8760 小时")
	}
	if c.CourseDetailsMaxPerRun < 1 || c.CourseDetailsMaxPerRun > 200 {
		return errors.New("每轮课程详情抓取上限须为 1–200 门")
	}
	if c.CourseDetailsDelayMilliseconds < 100 || c.CourseDetailsDelayMilliseconds > 10000 {
		return errors.New("课程详情请求间隔须为 100–10000 毫秒")
	}
	if len(c.CourseDetailCourseIDs) > 200 {
		return errors.New("固定核查课程号不能超过 200 个")
	}
	for _, courseID := range c.CourseDetailCourseIDs {
		if !courseIDPattern.MatchString(courseID) {
			return fmt.Errorf("固定核查课程号不合法：%s", courseID)
		}
	}
	for _, origin := range c.AllowedOrigins {
		if !strings.HasPrefix(origin, "http://") && !strings.HasPrefix(origin, "https://") {
			return fmt.Errorf("CORS 来源不合法：%s", origin)
		}
	}
	return nil
}

type Environment struct {
	ConfigPath       string
	EnvFilePath      string
	RepoDir          string
	SyncLockPath     string
	PublicAddr       string
	LiveAddr         string
	AdminAddr        string
	AdminPassword    string
	LiveSecret       string
	XKUsername       string
	XKPassword       string
	CFAccountID      string
	CFAPIToken       string
	CFPagesProject   string
	GitSSHCommand    string
	PythonExecutable string
}

func LoadEnvironment() Environment {
	home, _ := os.UserHomeDir()
	return Environment{
		ConfigPath:       envOr("BACKEND_CONFIG", filepath.Join(home, "apps", "jxnu-backend", "config.json")),
		EnvFilePath:      envOr("BACKEND_ENV_FILE", filepath.Join(home, "apps", "jxnu-backend", "backend.env")),
		RepoDir:          envOr("REPO_DIR", filepath.Join(home, "better-jxnu-elective-system")),
		SyncLockPath:     envOr("SYNC_LOCK", filepath.Join(home, "apps", "jxnu-backend", "sync.lock")),
		PublicAddr:       envOr("PUBLIC_ADDR", DefaultPublicAddr),
		LiveAddr:         envOr("LIVE_ADDR", DefaultLiveAddr),
		AdminAddr:        envOr("ADMIN_ADDR", DefaultAdminAddr),
		AdminPassword:    os.Getenv("ADMIN_PASSWORD"),
		LiveSecret:       os.Getenv("LIVE_SECRET"),
		XKUsername:       os.Getenv("XK_USERNAME"),
		XKPassword:       os.Getenv("XK_PASSWORD"),
		CFAccountID:      os.Getenv("CF_ACCOUNT_ID"),
		CFAPIToken:       os.Getenv("CF_API_TOKEN"),
		CFPagesProject:   envOr("CF_PAGES_PROJECT", "jxnu-elective-plus"),
		GitSSHCommand:    os.Getenv("GIT_SSH_COMMAND"),
		PythonExecutable: envOr("PYTHON", "python3"),
	}
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

type ConfigStore struct {
	path string
	mu   sync.RWMutex
	cfg  RuntimeConfig
}

func OpenConfigStore(path string) (*ConfigStore, error) {
	store := &ConfigStore{path: path, cfg: DefaultRuntimeConfig()}
	if err := store.Reload(); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if err := store.Save(store.cfg); err != nil {
			return nil, err
		}
	}
	return store, nil
}

func (s *ConfigStore) Path() string { return s.path }

func (s *ConfigStore) Get() RuntimeConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneConfig(s.cfg)
}

func (s *ConfigStore) Reload() error {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	cfg := DefaultRuntimeConfig()
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("读取运行配置: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("校验运行配置: %w", err)
	}
	s.mu.Lock()
	s.cfg = cloneConfig(cfg)
	s.mu.Unlock()
	return nil
}

func (s *ConfigStore) Save(cfg RuntimeConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := atomicWrite(s.path, raw, 0o600); err != nil {
		return err
	}
	s.mu.Lock()
	s.cfg = cloneConfig(cfg)
	s.mu.Unlock()
	return nil
}

func cloneConfig(cfg RuntimeConfig) RuntimeConfig {
	cfg.AllowedOrigins = append([]string(nil), cfg.AllowedOrigins...)
	cfg.CourseDetailCourseIDs = append([]string(nil), cfg.CourseDetailCourseIDs...)
	return cfg
}

func ParseAutomationForm(values map[string]string, current RuntimeConfig) (RuntimeConfig, error) {
	next := cloneConfig(current)
	next.AutoSyncEnabled = values["autoSyncEnabled"] == "on" || values["autoSyncEnabled"] == "true"
	next.CourseDetailsEnabled = values["courseDetailsEnabled"] == "on" || values["courseDetailsEnabled"] == "true"
	next.CourseDetailsVerifyTrackedEveryRun = values["courseDetailsVerifyTrackedEveryRun"] == "on" || values["courseDetailsVerifyTrackedEveryRun"] == "true"
	var err error
	if next.AutoSyncIntervalMinutes, err = parseInt(values, "autoSyncIntervalMinutes"); err != nil {
		return current, err
	}
	if next.CourseDetailsRefreshHours, err = parseInt(values, "courseDetailsRefreshHours"); err != nil {
		return current, err
	}
	if next.CourseDetailsMaxPerRun, err = parseInt(values, "courseDetailsMaxPerRun"); err != nil {
		return current, err
	}
	if next.CourseDetailsDelayMilliseconds, err = parseInt(values, "courseDetailsDelayMilliseconds"); err != nil {
		return current, err
	}
	ids := strings.FieldsFunc(values["courseDetailCourseIDs"], func(r rune) bool {
		return r == ',' || r == '\n' || r == '\r' || r == ' ' || r == '\t'
	})
	next.CourseDetailCourseIDs = next.CourseDetailCourseIDs[:0]
	seen := map[string]bool{}
	for _, courseID := range ids {
		courseID = strings.TrimSpace(courseID)
		if courseID != "" && !seen[courseID] {
			seen[courseID] = true
			next.CourseDetailCourseIDs = append(next.CourseDetailCourseIDs, courseID)
		}
	}
	sort.Strings(next.CourseDetailCourseIDs)
	if err := next.Validate(); err != nil {
		return current, err
	}
	return next, nil
}

func atomicWrite(path string, raw []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func ParseRuntimeForm(values map[string]string, current RuntimeConfig) (RuntimeConfig, error) {
	next := cloneConfig(current)
	next.DefaultDataSource = strings.TrimSpace(values["defaultDataSource"])
	next.LiveEnrollmentSemester = strings.TrimSpace(values["liveEnrollmentSemester"])
	next.ScheduleSyncSemester = strings.TrimSpace(values["scheduleSyncSemester"])
	mode := strings.TrimSpace(values["studentTermMode"])
	if mode == "auto" {
		next.StudentScheduleTerm = ""
	} else {
		next.StudentScheduleTerm = strings.TrimSpace(values["studentScheduleTerm"])
	}
	var err error
	if next.EnrollmentRefreshSeconds, err = parseInt(values, "enrollmentRefreshSeconds"); err != nil {
		return current, err
	}
	if next.StudentCacheSeconds, err = parseInt(values, "studentCacheSeconds"); err != nil {
		return current, err
	}
	next.CapacityStep = strings.TrimSpace(values["capacityStep"])
	next.CapacityEnabled = values["capacityEnabled"] == "on" || values["capacityEnabled"] == "true"
	if next.CapacityDelayMilliseconds, err = parseInt(values, "capacityDelayMilliseconds"); err != nil {
		return current, err
	}
	if next.MinScheduleRows, err = parseInt(values, "minScheduleRows"); err != nil {
		return current, err
	}
	if next.MinFormalSections, err = parseInt(values, "minFormalSections"); err != nil {
		return current, err
	}
	if next.MinCapacityVisible, err = parseInt(values, "minCapacityVisible"); err != nil {
		return current, err
	}
	origins := strings.FieldsFunc(values["allowedOrigins"], func(r rune) bool { return r == ',' || r == '\n' || r == '\r' })
	next.AllowedOrigins = next.AllowedOrigins[:0]
	seen := map[string]bool{}
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin != "" && !seen[origin] {
			seen[origin] = true
			next.AllowedOrigins = append(next.AllowedOrigins, origin)
		}
	}
	if err := next.Validate(); err != nil {
		return current, err
	}
	return next, nil
}

func parseInt(values map[string]string, key string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(values[key]))
	if err != nil {
		return 0, fmt.Errorf("%s 必须是整数", key)
	}
	return n, nil
}

func SemesterOptions(repoDir string) []string {
	paths, _ := filepath.Glob(filepath.Join(repoDir, "data", "semesters", "*", "meta.json"))
	options := make([]string, 0, len(paths))
	for _, path := range paths {
		label := filepath.Base(filepath.Dir(path))
		if semesterPattern.MatchString(label) {
			options = append(options, label)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(options)))
	return options
}

func AcademicTermOptions(semesters []string, selected string, now time.Time) []string {
	seen := map[string]bool{}
	add := func(value string) {
		if termPattern.MatchString(value) {
			seen[value] = true
		}
	}
	for _, sem := range semesters {
		if value, ok := AcademicTermFromSemester(sem); ok {
			add(value)
		}
	}
	add(selected)
	for year := now.Year() - 1; year <= now.Year()+2; year++ {
		add(fmt.Sprintf("%02d-%02d第1学期", year%100, (year+1)%100))
		add(fmt.Sprintf("%02d-%02d第2学期", year%100, (year+1)%100))
	}
	options := make([]string, 0, len(seen))
	for value := range seen {
		options = append(options, value)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(options)))
	return options
}

func AcademicTermFromSemester(semester string) (string, bool) {
	if !semesterPattern.MatchString(semester) {
		return "", false
	}
	year, _ := strconv.Atoi(semester[:4])
	if strings.HasSuffix(semester, "-09") {
		return fmt.Sprintf("%02d-%02d第1学期", year%100, (year+1)%100), true
	}
	return fmt.Sprintf("%02d-%02d第2学期", (year-1)%100, year%100), true
}
