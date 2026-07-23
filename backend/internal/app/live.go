package app

import (
	"context"
	"crypto/subtle"
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
	master      *MasterContext
	masterMTime time.Time
	started     time.Time
	lastError   string
	lastFetch   time.Time
	terms       []string
}

func NewLiveStudentService(env Environment, config *ConfigStore, logger *slog.Logger) *LiveStudentService {
	return &LiveStudentService{env: env, config: config, client: NewJWCClient(env.XKUsername, env.XKPassword), logger: logger, cache: map[string]studentCacheEntry{}, started: time.Now()}
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
		s.setError(err)
		return nil, err
	}
	built := BuildStudentRecord(sid, aggregate, master)
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
	return payload, nil
}

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

func (s *LiveStudentService) setError(err error) {
	s.mu.Lock()
	s.lastError = err.Error()
	s.lastFetch = time.Now()
	s.mu.Unlock()
	s.logger.Error("学号实时课表查询失败", "error", err)
}

func (s *LiveStudentService) Health() map[string]any {
	cfg := s.config.Get()
	s.mu.RLock()
	defer s.mu.RUnlock()
	return map[string]any{"ok": s.env.XKUsername != "" && s.env.XKPassword != "", "authed": s.client.IsAuthed(), "cacheSize": len(s.cache), "ctxLoaded": s.master != nil,
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

func (s *LiveStudentService) ClearCache() {
	s.mu.Lock()
	s.cache = map[string]studentCacheEntry{}
	s.mu.Unlock()
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
