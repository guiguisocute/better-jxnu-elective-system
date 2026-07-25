package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
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
	DefaultPublicAddr  = "127.0.0.1:8787"
	DefaultLiveAddr    = "127.0.0.1:8788"
	DefaultAdminAddr   = "127.0.0.1:8790"
	DefaultCapacityURL = "https://xk.jxnu.edu.cn/Step3/ChangeClass.aspx?kch={courseId}&action=change"
)

var (
	semesterPattern = regexp.MustCompile(`^\d{4}-(03|09)$`)
	termPattern     = regexp.MustCompile(`^\d{2}-\d{2}第\d{1,2}学期$`)
)

// AcquisitionTarget is one collector's term identity. The repository key is
// the source of truth; school-specific representations are always derived from
// it. Preselect is separate; formal and add/drop deliberately share one target.
type AcquisitionTarget struct {
	Semester     string `json:"semester"`
	AcademicTerm string `json:"academicTerm"`
	SchoolDate   string `json:"schoolDate"`
}

func ResolveAcquisitionTarget(semester string) (AcquisitionTarget, bool) {
	term, ok := AcademicTermFromSemester(semester)
	if !ok {
		return AcquisitionTarget{}, false
	}
	year, _ := strconv.Atoi(semester[:4])
	month, _ := strconv.Atoi(semester[5:])
	return AcquisitionTarget{
		Semester: semester, AcademicTerm: term,
		SchoolDate: fmt.Sprintf("%04d/%d/1 0:00:00", year, month),
	}, true
}

// RuntimeConfig contains the ordinary operational choices that should take
// effect immediately. Secrets stay in the systemd EnvironmentFile.
type RuntimeConfig struct {
	Version int `json:"version"`
	// SiteOrigin / BackendPublicURL are this deployment's identity: where the
	// frontend is served from, and where this backend is reachable from the
	// public internet. They used to exist only as the original author's domains
	// baked into source defaults, which made a fork silently talk to (and load)
	// the upstream deployment. Both are set in 部署配置 and drive the CORS
	// allowlist plus the copy-paste frontend wiring the panel prints.
	// Empty is allowed — the backend still serves; only the derived hints and
	// the auto-CORS entry are skipped.
	SiteOrigin                     string   `json:"siteOrigin"`
	BackendPublicURL               string   `json:"backendPublicUrl"`
	DefaultDataSource              string   `json:"defaultDataSource"`
	PreselectSemester              string   `json:"preselectSemester"`
	SelectionSemester              string   `json:"selectionSemester"`
	StudentScheduleTerm            string   `json:"studentScheduleTerm"`
	EnrollmentRefreshSeconds       int      `json:"enrollmentRefreshSeconds"`
	StudentCacheSeconds            int      `json:"studentCacheSeconds"`
	SelectionCapacityEnabled       bool     `json:"selectionCapacityEnabled"`
	SelectionCapacityURL           string   `json:"selectionCapacityUrl"`
	CapacityDelayMilliseconds      int      `json:"capacityDelayMilliseconds"`
	MinSelectionScheduleRows       int      `json:"minSelectionScheduleRows"`
	MinSelectionSections           int      `json:"minSelectionSections"`
	MinSelectionCapacityVisible    int      `json:"minSelectionCapacityVisible"`
	AllowedOrigins                 []string `json:"allowedOrigins"`
	AutoSyncEnabled                bool     `json:"autoSyncEnabled"`
	AutoSyncIntervalMinutes        int      `json:"autoSyncIntervalMinutes"`
	SelectionScheduleWatchEnabled  bool     `json:"selectionScheduleWatchEnabled"`
	FormalScheduleStableChecks     int      `json:"formalScheduleStableChecks"`
	CourseDetailsEnabled           bool     `json:"courseDetailsEnabled"`
	CourseDetailsRefreshHours      int      `json:"courseDetailsRefreshHours"`
	CourseDetailsMaxPerRun         int      `json:"courseDetailsMaxPerRun"`
	CourseDetailsDelayMilliseconds int      `json:"courseDetailsDelayMilliseconds"`
}

func DefaultRuntimeConfig() RuntimeConfig {
	return RuntimeConfig{
		Version:                        6,
		DefaultDataSource:              "formal",
		PreselectSemester:              "2026-09",
		SelectionSemester:              "2026-09",
		StudentScheduleTerm:            "",
		EnrollmentRefreshSeconds:       30,
		StudentCacheSeconds:            600,
		SelectionCapacityEnabled:       false,
		SelectionCapacityURL:           DefaultCapacityURL,
		CapacityDelayMilliseconds:      100,
		MinSelectionScheduleRows:       6000,
		MinSelectionSections:           4000,
		MinSelectionCapacityVisible:    300,
		AutoSyncEnabled:                true,
		AutoSyncIntervalMinutes:        60,
		SelectionScheduleWatchEnabled:  true,
		FormalScheduleStableChecks:     2,
		CourseDetailsEnabled:           true,
		CourseDetailsRefreshHours:      168,
		CourseDetailsMaxPerRun:         30,
		CourseDetailsDelayMilliseconds: 300,
		// Only local development origins ship as defaults. A deployment's real
		// origin comes from SiteOrigin (部署配置) — hardcoding the upstream
		// author's domains here meant every fork started with a CORS allowlist
		// for somebody else's site.
		AllowedOrigins: []string{
			"http://localhost:5173",
			"http://127.0.0.1:5173",
		},
	}
}

// AcquisitionProfile describes the only pipeline allowed to run for the
// configured default page. Preselect is intentionally offline until its CAS
// Step1 contract is verified; formal and add/drop share one schedule and one
// capacity snapshot, with only the capacity URL changing over time.
type AcquisitionProfile struct {
	DataSource           string
	Label                string
	Semester             string
	RawFilename          string
	CapacityFilename     string
	KKAPEnabled          bool
	CapacityEnabled      bool
	CapacityURL          string
	LiveEnrollment       bool
	CourseDetailsEnabled bool
	MinScheduleRows      int
	MinSections          int
	MinCapacityVisible   int
}

func (c RuntimeConfig) ActiveAcquisitionProfile() AcquisitionProfile {
	switch c.DefaultDataSource {
	case "pre":
		return AcquisitionProfile{
			DataSource: "pre", Label: "预选", Semester: c.PreselectSemester,
			RawFilename: "preselect_catalog.json",
		}
	default:
		return AcquisitionProfile{
			DataSource: "formal", Label: "正选/补退选", Semester: c.SelectionSemester,
			RawFilename: "formal_schedule.json", CapacityFilename: "formal_capacity.json",
			KKAPEnabled: c.SelectionScheduleWatchEnabled, CapacityEnabled: c.SelectionCapacityEnabled,
			CapacityURL: c.SelectionCapacityURL, LiveEnrollment: true, CourseDetailsEnabled: true,
			MinScheduleRows: c.MinSelectionScheduleRows, MinSections: c.MinSelectionSections,
			MinCapacityVisible: c.MinSelectionCapacityVisible,
		}
	}
}

// LiveEnrollmentTarget is derived from the active display stage. Preselect has
// no live headcount semantics, so returning an empty target disables polling.
func (c RuntimeConfig) LiveEnrollmentTarget() string {
	profile := c.ActiveAcquisitionProfile()
	if !profile.LiveEnrollment {
		return ""
	}
	return profile.Semester
}

func (c RuntimeConfig) Validate() error {
	if c.Version != 6 {
		return fmt.Errorf("不支持的配置版本 %d", c.Version)
	}
	for label, value := range map[string]string{"站点地址": c.SiteOrigin, "后端对外地址": c.BackendPublicURL} {
		if value == "" {
			continue
		}
		if err := validateDeploymentOrigin(value); err != nil {
			return fmt.Errorf("%s%s", label, err)
		}
	}
	if c.DefaultDataSource != "pre" && c.DefaultDataSource != "formal" {
		return errors.New("默认选课阶段必须是 pre 或 formal")
	}
	for label, value := range map[string]string{
		"预选目标学期":     c.PreselectSemester,
		"正选/补退选目标学期": c.SelectionSemester,
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
	if err := validateCapacityURL(c.SelectionCapacityURL); err != nil {
		return err
	}
	if c.CapacityDelayMilliseconds < 0 || c.CapacityDelayMilliseconds > 10000 {
		return errors.New("容量请求间隔须为 0–10000 毫秒")
	}
	if c.MinSelectionScheduleRows < 1 || c.MinSelectionSections < 1 || c.MinSelectionCapacityVisible < 0 {
		return errors.New("同步安全阈值不合法")
	}
	if c.AutoSyncIntervalMinutes < 15 || c.AutoSyncIntervalMinutes > 1440 {
		return errors.New("自动构建间隔须为 15–1440 分钟")
	}
	if c.FormalScheduleStableChecks < 1 || c.FormalScheduleStableChecks > 10 {
		return errors.New("KKAP 连续稳定检查次数须为 1–10 次")
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
	for _, origin := range c.AllowedOrigins {
		if !strings.HasPrefix(origin, "http://") && !strings.HasPrefix(origin, "https://") {
			return fmt.Errorf("CORS 来源不合法：%s", origin)
		}
	}
	return nil
}

// validateDeploymentOrigin accepts a scheme+host root URL ("https://x.example"),
// which is what both a browser Origin header and a fetch base need. Paths,
// queries and credentials are rejected so the derived CORS entry can be compared
// byte-for-byte against the Origin header.
func validateDeploymentOrigin(value string) error {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("必须是形如 https://example.edu 的完整地址，且不带账号、query 或 fragment")
	}
	host := strings.ToLower(parsed.Hostname())
	localHTTP := parsed.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
	if parsed.Scheme != "https" && !localHTTP {
		return errors.New("必须使用 https（仅 localhost 可用 http）")
	}
	if strings.Trim(parsed.Path, "/") != "" {
		return errors.New("只填到域名即可，不要带路径")
	}
	return nil
}

// NormalizeDeploymentOrigin strips a trailing slash so the stored value matches
// the browser's Origin header exactly.
func NormalizeDeploymentOrigin(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return strings.TrimRight(value, "/")
}

func validateCapacityURL(value string) error {
	if !strings.Contains(value, "{courseId}") {
		return errors.New("容量嗅探 URL 必须包含 {courseId} 占位符")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Host, "xk.jxnu.edu.cn") || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("容量嗅探 URL 必须是 https://xk.jxnu.edu.cn 下的完整地址")
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
	CFD1DatabaseID   string
	GitSSHCommand    string
	PythonExecutable string
}

func LoadEnvironment() Environment {
	home, _ := os.UserHomeDir()
	return Environment{
		ConfigPath:    envOr("BACKEND_CONFIG", filepath.Join(home, "apps", "jxnu-backend", "config.json")),
		EnvFilePath:   envOr("BACKEND_ENV_FILE", filepath.Join(home, "apps", "jxnu-backend", "backend.env")),
		RepoDir:       envOr("REPO_DIR", filepath.Join(home, "better-jxnu-elective-system")),
		SyncLockPath:  envOr("SYNC_LOCK", filepath.Join(home, "apps", "jxnu-backend", "sync.lock")),
		PublicAddr:    envOr("PUBLIC_ADDR", DefaultPublicAddr),
		LiveAddr:      envOr("LIVE_ADDR", DefaultLiveAddr),
		AdminAddr:     envOr("ADMIN_ADDR", DefaultAdminAddr),
		AdminPassword: os.Getenv("ADMIN_PASSWORD"),
		LiveSecret:    os.Getenv("LIVE_SECRET"),
		XKUsername:    os.Getenv("XK_USERNAME"),
		XKPassword:    os.Getenv("XK_PASSWORD"),
		CFAccountID:   os.Getenv("CF_ACCOUNT_ID"),
		CFAPIToken:    os.Getenv("CF_API_TOKEN"),
		// No defaults: these identify one specific Cloudflare account's project
		// and database. Baking the upstream author's values in meant a fork
		// pointed at resources it has no access to, and the failure surfaced as
		// a confusing auth error instead of "you haven't configured this yet".
		// Both are set in 部署配置 / 评价管理, which writes them to backend.env.
		CFPagesProject:   os.Getenv("CF_PAGES_PROJECT"),
		CFD1DatabaseID:   os.Getenv("CF_D1_DATABASE_ID"),
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
	var legacy legacyRuntimeConfig
	_ = json.Unmarshal(raw, &legacy)
	migrated, err := migrateRuntimeConfig(&cfg, legacy)
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("校验运行配置: %w", err)
	}
	if migrated {
		updated, marshalErr := json.MarshalIndent(cfg, "", "  ")
		if marshalErr != nil {
			return marshalErr
		}
		if writeErr := atomicWrite(s.path, append(updated, '\n'), 0o600); writeErr != nil {
			return fmt.Errorf("写入迁移后的运行配置: %w", writeErr)
		}
	}
	s.mu.Lock()
	s.cfg = cloneConfig(cfg)
	s.mu.Unlock()
	return nil
}

type legacyRuntimeConfig struct {
	LiveEnrollmentSemester     string `json:"liveEnrollmentSemester"`
	ScheduleSyncSemester       string `json:"scheduleSyncSemester"`
	CapacityEnabled            bool   `json:"capacityEnabled"`
	CapacityStep               string `json:"capacityStep"`
	FormalScheduleWatchEnabled *bool  `json:"formalScheduleWatchEnabled"`
	MinScheduleRows            int    `json:"minScheduleRows"`
}

func migrateRuntimeConfig(cfg *RuntimeConfig, legacy legacyRuntimeConfig) (bool, error) {
	if cfg.Version == 6 {
		return false, nil
	}
	if cfg.Version < 1 || cfg.Version > 5 {
		return false, fmt.Errorf("不支持的配置版本 %d", cfg.Version)
	}
	// v6 adds the deployment identity (siteOrigin / backendPublicUrl). An
	// existing install already encodes its site origin in the CORS allowlist, so
	// adopt the first non-local entry rather than making the operator retype it.
	if cfg.Version == 5 {
		cfg.SiteOrigin = firstPublicOrigin(cfg.AllowedOrigins)
		cfg.Version = 6
		return true, nil
	}
	// v4 removed the course-number whitelist entirely. Unknown legacy JSON
	// fields are ignored on read and disappear when this migrated config is
	// atomically persisted. v5 separates the CAS preselect catalog from the one
	// shared formal/add-drop schedule and makes the capacity endpoint explicit.
	target := strings.TrimSpace(legacy.ScheduleSyncSemester)
	if !semesterPattern.MatchString(target) {
		target = strings.TrimSpace(legacy.LiveEnrollmentSemester)
	}
	if !semesterPattern.MatchString(target) {
		target = "2026-09"
	}
	cfg.PreselectSemester = target
	cfg.SelectionSemester = target
	cfg.SelectionCapacityEnabled = legacy.CapacityEnabled
	if legacy.FormalScheduleWatchEnabled != nil {
		cfg.SelectionScheduleWatchEnabled = *legacy.FormalScheduleWatchEnabled
	}
	if legacy.MinScheduleRows > 0 {
		cfg.MinSelectionScheduleRows = legacy.MinScheduleRows
	}
	if cfg.DefaultDataSource == "addDrop" {
		cfg.DefaultDataSource = "formal"
	}
	// v4 counted formal_sections across every semester (default 7000). v5
	// validates only the active target semester, so the old number is not
	// comparable; use the stage-local safety default.
	cfg.MinSelectionSections = 4000
	if regexp.MustCompile(`^Step[1-9]$`).MatchString(legacy.CapacityStep) {
		cfg.SelectionCapacityURL = strings.Replace(DefaultCapacityURL, "Step3", legacy.CapacityStep, 1)
	}
	cfg.SiteOrigin = firstPublicOrigin(cfg.AllowedOrigins)
	cfg.Version = 6
	return true, nil
}

// firstPublicOrigin picks the first non-loopback entry of an existing CORS
// allowlist, which for any already-running install is its real site origin.
func firstPublicOrigin(origins []string) string {
	for _, origin := range origins {
		parsed, err := url.Parse(strings.TrimSpace(origin))
		if err != nil || parsed.Host == "" {
			continue
		}
		host := strings.ToLower(parsed.Hostname())
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			continue
		}
		return NormalizeDeploymentOrigin(origin)
	}
	return ""
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
	return cfg
}

func ParseAutomationForm(values map[string]string, current RuntimeConfig) (RuntimeConfig, error) {
	next := cloneConfig(current)
	next.AutoSyncEnabled = values["autoSyncEnabled"] == "on" || values["autoSyncEnabled"] == "true"
	next.SelectionScheduleWatchEnabled = values["selectionScheduleWatchEnabled"] == "on" || values["selectionScheduleWatchEnabled"] == "true"
	next.CourseDetailsEnabled = values["courseDetailsEnabled"] == "on" || values["courseDetailsEnabled"] == "true"
	var err error
	if next.AutoSyncIntervalMinutes, err = parseInt(values, "autoSyncIntervalMinutes"); err != nil {
		return current, err
	}
	if next.FormalScheduleStableChecks, err = parseInt(values, "formalScheduleStableChecks"); err != nil {
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
	next.PreselectSemester = strings.TrimSpace(values["preselectSemester"])
	next.SelectionSemester = strings.TrimSpace(values["selectionSemester"])
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
	next.SelectionCapacityURL = strings.TrimSpace(values["selectionCapacityUrl"])
	next.SelectionCapacityEnabled = values["selectionCapacityEnabled"] == "on" || values["selectionCapacityEnabled"] == "true"
	if next.CapacityDelayMilliseconds, err = parseInt(values, "capacityDelayMilliseconds"); err != nil {
		return current, err
	}
	if next.MinSelectionScheduleRows, err = parseInt(values, "minSelectionScheduleRows"); err != nil {
		return current, err
	}
	if next.MinSelectionSections, err = parseInt(values, "minSelectionSections"); err != nil {
		return current, err
	}
	if next.MinSelectionCapacityVisible, err = parseInt(values, "minSelectionCapacityVisible"); err != nil {
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

func SemesterTargetOptions(existing []string, selected string, now time.Time) []string {
	seen := map[string]bool{}
	for _, value := range existing {
		if semesterPattern.MatchString(value) {
			seen[value] = true
		}
	}
	if semesterPattern.MatchString(selected) {
		seen[selected] = true
	}
	for year := now.Year() - 1; year <= now.Year()+2; year++ {
		seen[fmt.Sprintf("%04d-03", year)] = true
		seen[fmt.Sprintf("%04d-09", year)] = true
	}
	values := make([]string, 0, len(seen))
	for value := range seen {
		values = append(values, value)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(values)))
	return values
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

// SemesterFromSchoolDate maps values used by JXNU ASP.NET term dropdowns and
// KKAP row links (for example "2027/3/1 0:00:00") to the repository's single
// canonical semester key.
func SemesterFromSchoolDate(value string) (string, bool) {
	match := regexp.MustCompile(`^(\d{4})/(\d{1,2})/\d{1,2}(?:\s+.*)?$`).FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return "", false
	}
	month, _ := strconv.Atoi(match[2])
	if month != 3 && month != 9 {
		return "", false
	}
	return fmt.Sprintf("%s-%02d", match[1], month), true
}
