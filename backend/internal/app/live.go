package app

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type studentCacheEntry struct {
	expires time.Time
	payload map[string]any
}

type LiveStudentService struct {
	env         Environment
	config      *ConfigStore
	client      *JWCClient
	logger      *slog.Logger
	fetchMu     sync.Mutex
	mu          sync.RWMutex
	cache       map[string]studentCacheEntry
	termCache   *termCourseCache
	master      *MasterContext
	masterMTime time.Time
	started     time.Time
	lastError   string
	lastFetch   time.Time
	terms       []string
}

func NewLiveStudentService(env Environment, config *ConfigStore, logger *slog.Logger) *LiveStudentService {
	client := NewJWCClient(env.XKUsername, env.XKPassword)
	// 缓存文件与其它运行期状态放一起（enrollment_snapshot.json 等旁边）。
	terms := newTermCourseCache(filepath.Join(filepath.Dir(env.ConfigPath), "student_terms.json"))
	client.termCache = terms
	return &LiveStudentService{env: env, config: config, client: client, logger: logger,
		cache: map[string]studentCacheEntry{}, termCache: terms, started: time.Now()}
}

// keepAliveInterval pings the JWC while a session exists. The legacy ASP.NET app
// expires sessions after ~20 minutes of inactivity, and re-logging in costs the
// user a lot: a fetch that has to log in first measured 8.7s against 2.0s on a
// live session — close enough to the Pages Function's 10s timeout that the site
// silently falls back to the stale D1 snapshot instead of showing live data.
const keepAliveInterval = 5 * time.Minute

// RunKeepAlive holds the JWC session open and flushes the term cache. It never
// logs in on its own: without a prior real query there is nothing to keep alive,
// and an idle backend should not be hitting the school's login endpoint.
func (s *LiveStudentService) RunKeepAlive(ctx context.Context) {
	ticker := time.NewTicker(keepAliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.termCache.Flush(true)
			return
		case <-ticker.C:
		}
		s.termCache.Flush(true)
		if !s.client.IsAuthed() {
			continue
		}
		// fetchMu keeps the ping from interleaving with a real query's stateful
		// postback sequence.
		if !s.fetchMu.TryLock() {
			continue
		}
		pingCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err := s.client.Ping(pingCtx)
		cancel()
		s.fetchMu.Unlock()
		if err != nil {
			s.logger.Warn("教务会话保活失败，下次查询会重新登录", "error", err)
		}
	}
}

func (s *LiveStudentService) CheckSecret(value string) bool {
	if s.env.LiveSecret == "" {
		return false
	}
	return len(value) == len(s.env.LiveSecret) && subtle.ConstantTimeCompare([]byte(value), []byte(s.env.LiveSecret)) == 1
}

func (s *LiveStudentService) GetRecord(ctx context.Context, sid string) (map[string]any, error) {
	if !regexp.MustCompile(`^\d{6,20}$`).MatchString(sid) {
		return nil, fmt.Errorf("学号格式不正确")
	}
	cfg := s.config.Get()
	key := sid + "\x00" + cfg.StudentScheduleTerm
	now := time.Now()
	s.mu.RLock()
	hit, ok := s.cache[key]
	s.mu.RUnlock()
	if ok && hit.expires.After(now) {
		return hit.payload, nil
	}
	s.fetchMu.Lock()
	defer s.fetchMu.Unlock()
	s.mu.RLock()
	hit, ok = s.cache[key]
	s.mu.RUnlock()
	if ok && hit.expires.After(time.Now()) {
		return hit.payload, nil
	}
	master, err := s.ensureMaster()
	if err != nil {
		return nil, err
	}
	aggregate, err := s.client.FetchStudent(ctx, sid, cfg.StudentScheduleTerm)
	if err != nil {
		s.setError(err, sid)
		return nil, err
	}
	built := BuildStudentRecord(sid, aggregate, master, cfg.FinalizedTerm)
	payload := map[string]any{"source": "live", "row": map[string]any{
		"className": built.Row["class_name"], "planKey": built.Row["plan_key"], "totalEarned": built.Row["total_earned"], "takenCount": built.Row["taken_count"],
	}, "record": built.Record}
	s.mu.Lock()
	for cacheKey, entry := range s.cache {
		if entry.expires.Before(now) {
			delete(s.cache, cacheKey)
		}
	}
	if len(s.cache) >= 2048 {
		type pair struct {
			key     string
			expires time.Time
		}
		all := make([]pair, 0, len(s.cache))
		for cacheKey, entry := range s.cache {
			all = append(all, pair{cacheKey, entry.expires})
		}
		sort.Slice(all, func(i, j int) bool { return all[i].expires.Before(all[j].expires) })
		for i := 0; i < len(all)/4+1; i++ {
			delete(s.cache, all[i].key)
		}
	}
	s.cache[key] = studentCacheEntry{time.Now().Add(time.Duration(cfg.StudentCacheSeconds) * time.Second), payload}
	s.lastError = ""
	s.lastFetch = time.Now()
	s.terms = append([]string(nil), aggregate.AvailableTerms...)
	s.mu.Unlock()
	// 落盘有 30s 去抖，连续查询只写一次。
	s.termCache.Flush(false)
	return payload, nil
}

// RefreshRecord fetches one student straight from 教务 and rebuilds the record,
// bypassing the short-lived whole-record cache. 固化学期 uses it: a batch that
// served its own cached answers back to itself would persist nothing new.
// It shares fetchMu with GetRecord, so a batch run and a user query can never
// interleave their stateful postback sequences.
func (s *LiveStudentService) RefreshRecord(ctx context.Context, sid string) (BuiltStudentRecord, error) {
	if !regexp.MustCompile(`^\d{6,20}$`).MatchString(sid) {
		return BuiltStudentRecord{}, fmt.Errorf("学号格式不正确")
	}
	cfg := s.config.Get()
	s.fetchMu.Lock()
	defer s.fetchMu.Unlock()
	master, err := s.ensureMaster()
	if err != nil {
		return BuiltStudentRecord{}, err
	}
	aggregate, err := s.client.FetchStudent(ctx, sid, cfg.StudentScheduleTerm)
	if err != nil {
		s.setError(err, sid)
		return BuiltStudentRecord{}, err
	}
	built := BuildStudentRecord(sid, aggregate, master, cfg.FinalizedTerm)
	s.mu.Lock()
	s.lastError = ""
	s.lastFetch = time.Now()
	s.terms = append([]string(nil), aggregate.AvailableTerms...)
	s.mu.Unlock()
	s.termCache.Flush(false)
	return built, nil
}

// WithClient runs fn against the shared 教务 session, serialized against student
// queries by the same mutex their stateful postbacks use.
//
// 新生嗅探必须共用这个 client 而不是自己 new 一个：另起一个 JWCClient 就是另一次
// CAS 登录，学校侧同账号并发会话会把正在服务用户的那条会话顶掉。代价是嗅探期间
// 学号查询要排队——嗅探本身是低频后台任务，这个取舍是划算的。
func (s *LiveStudentService) WithClient(ctx context.Context, fn func(*JWCClient) error) error {
	s.fetchMu.Lock()
	defer s.fetchMu.Unlock()
	if !s.client.IsAuthed() {
		if err := s.client.Login(ctx); err != nil {
			return err
		}
	}
	return fn(s.client)
}

// EnsureMaster exposes the lazily-loaded master context (course + plan lookup
// tables) to other services, reusing this one's mtime-based cache.
func (s *LiveStudentService) EnsureMaster() (*MasterContext, error) { return s.ensureMaster() }

func (s *LiveStudentService) ensureMaster() (*MasterContext, error) {
	path := filepath.Join(s.env.RepoDir, "data", "master", "courses.json")
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	current, mtime := s.master, s.masterMTime
	s.mu.RUnlock()
	if current != nil && !info.ModTime().After(mtime) {
		return current, nil
	}
	loaded, err := LoadMasterContext(filepath.Join(s.env.RepoDir, "data", "master"))
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.master = loaded
	s.masterMTime = info.ModTime()
	s.mu.Unlock()
	return loaded, nil
}

func (s *LiveStudentService) setError(err error, sid string) {
	message := redactStudentID(err.Error(), sid)
	s.mu.Lock()
	s.lastError = message
	s.lastFetch = time.Now()
	s.mu.Unlock()
	s.logger.Error("学号实时课表查询失败", "student", maskedStudentID(sid), "error", message)
}

func maskedStudentID(sid string) string {
	if len(sid) <= 4 {
		return "****"
	}
	return sid[:4] + "****"
}

func redactStudentID(message, sid string) string {
	if sid == "" {
		return message
	}
	variants := []string{
		sid,
		base64.StdEncoding.EncodeToString([]byte(sid)),
		base64.RawStdEncoding.EncodeToString([]byte(sid)),
		base64.URLEncoding.EncodeToString([]byte(sid)),
		base64.RawURLEncoding.EncodeToString([]byte(sid)),
	}
	for _, variant := range variants {
		message = strings.ReplaceAll(message, variant, "[student-id]")
	}
	return message
}

func (s *LiveStudentService) Health() map[string]any {
	cfg := s.config.Get()
	termStudents, termEntries, termHits, termMisses := s.termCache.Stats()
	s.mu.RLock()
	defer s.mu.RUnlock()
	return map[string]any{"ok": s.env.XKUsername != "" && s.env.XKPassword != "", "authed": s.client.IsAuthed(), "cacheSize": len(s.cache), "ctxLoaded": s.master != nil,
		"termCacheStudents": termStudents, "termCacheEntries": termEntries, "termCacheHits": termHits, "termCacheMisses": termMisses,
		"uptimeSec": mathRound(time.Since(s.started).Seconds(), 1), "studentScheduleTerm": nullableString(cfg.StudentScheduleTerm), "termMode": map[bool]string{true: "auto", false: "fixed"}[cfg.StudentScheduleTerm == ""],
		"availableTerms": s.terms, "lastError": nullableString(s.lastError), "lastFetchAt": nullableTime(s.lastFetch)}
}

func mathRound(value float64, places int) float64 {
	factor := 1.0
	for i := 0; i < places; i++ {
		factor *= 10
	}
	return float64(int64(value*factor+0.5)) / factor
}
func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UTC().Format(time.RFC3339)
}

// FlushTermCache writes the per-term cache to disk unconditionally. Called on
// shutdown: the 30 s write debounce means a restart would otherwise drop every
// term learned since the last write, and those are exactly the students who
// would then pay full price on the next lookup.
func (s *LiveStudentService) FlushTermCache() { s.termCache.Flush(true) }

// ClearCache drops both the short-lived whole-record cache and the persistent
// per-term one. The panel calls this after 日常设置 changes, which is also the
// escape hatch if the registrar retroactively edits a past term's grades.
func (s *LiveStudentService) ClearCache() {
	s.mu.Lock()
	s.cache = map[string]studentCacheEntry{}
	s.mu.Unlock()
	s.termCache.Clear()
}
func (s *LiveStudentService) AvailableTerms() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string(nil), s.terms...)
}
func cacheKeySID(key string) string {
	if at := strings.IndexByte(key, 0); at >= 0 {
		return key[:at]
	}
	return key
}
