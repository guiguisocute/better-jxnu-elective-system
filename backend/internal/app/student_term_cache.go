package app

import (
	"encoding/json"
	"os"
	"sort"
	"sync"
	"time"
)

// 按学期持久化的已修课程缓存。
//
// 教务的学号课表页是一个有状态的 ASP.NET 表单：想看第 N 个学期，必须带着上一次响应
// 里的 __VIEWSTATE 再 POST 一次（jwc.go 的 FetchStudent 循环）。所以一次学号查询的
// 成本 = 学期数 × 一次往返，而下拉里通常有 12 个学期，实测一次查询 ~2.0s（会话已登录）
// 到 ~8.7s（需要重新登录）——后者已经逼近 Pages Function 侧 10s 的超时。
//
// 但这 12 个学期里只有「当前学期」会变：往期成绩一旦出分就不再改动。于是这里把
// 「(学号, 学期) → 已修课程」落盘，往期命中缓存就整个跳过那次翻页，每次查询的
// 翻页次数从 12 降到 1。
//
// 有意不缓存的东西：
//   - 当前（planning）学期：每次都实时拉，实时性正是这条链路存在的理由。
//   - 课表格子（ScheduleItems）：它只来自 planning 学期那一页，本来就每次重取。
//
// 陈旧风险：教务事后修改往期成绩时缓存会滞后。补考/重修在教务里表现为后续学期的新
// 记录，不改旧学期，所以正常教学流程不受影响；真出现更正时，面板「日常设置」保存会
// 调 ClearCache()，或者等 termCacheTTL 到期。

const (
	// termCacheTTL bounds staleness for past terms. Long, because past-term data
	// is immutable in normal operation; short enough that a registrar correction
	// heals on its own within a semester.
	termCacheTTL = 60 * 24 * time.Hour
	// termCacheMaxStudents caps the on-disk file. Entries are evicted
	// least-recently-used first. ~60 courses per student, so a few thousand
	// students stays in the tens of megabytes.
	termCacheMaxStudents = 3000
	// termCacheFlushInterval debounces disk writes: a burst of lookups produces
	// one write, not one per student.
	termCacheFlushInterval = 30 * time.Second
)

// termCacheEntry is one student's courses for one term.
type termCacheEntry struct {
	Courses  []DetailCourse `json:"courses"`
	StoredAt time.Time      `json:"storedAt"`
	UsedAt   time.Time      `json:"usedAt"`
}

// termCourseCache is safe for concurrent use. Keys are sid + "\x00" + termValue.
type termCourseCache struct {
	mu       sync.Mutex
	path     string
	entries  map[string]termCacheEntry
	dirty    bool
	lastSave time.Time
	hits     int
	misses   int
}

func newTermCourseCache(path string) *termCourseCache {
	cache := &termCourseCache{path: path, entries: map[string]termCacheEntry{}}
	cache.load()
	return cache
}

func termCacheKey(sid, termValue string) string { return sid + "\x00" + termValue }

// load reads the snapshot. A missing or corrupt file is not an error: the cache
// simply starts empty and refills, which costs latency but never correctness.
func (c *termCourseCache) load() {
	if c.path == "" {
		return
	}
	raw, err := os.ReadFile(c.path)
	if err != nil {
		return
	}
	var stored map[string]termCacheEntry
	if err := json.Unmarshal(raw, &stored); err != nil {
		return
	}
	cutoff := time.Now().Add(-termCacheTTL)
	for key, entry := range stored {
		if entry.StoredAt.After(cutoff) {
			c.entries[key] = entry
		}
	}
}

// Get returns a cached term's courses, refreshing its LRU stamp on a hit.
func (c *termCourseCache) Get(sid, termValue string) ([]DetailCourse, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[termCacheKey(sid, termValue)]
	if !ok || time.Since(entry.StoredAt) > termCacheTTL {
		c.misses++
		return nil, false
	}
	entry.UsedAt = time.Now()
	c.entries[termCacheKey(sid, termValue)] = entry
	c.hits++
	c.dirty = true
	return entry.Courses, true
}

// Put stores one term's courses. Callers must never store the planning term.
func (c *termCourseCache) Put(sid, termValue string, courses []DetailCourse) {
	if c == nil || termValue == "" {
		return
	}
	now := time.Now()
	c.mu.Lock()
	c.entries[termCacheKey(sid, termValue)] = termCacheEntry{Courses: courses, StoredAt: now, UsedAt: now}
	c.dirty = true
	c.mu.Unlock()
}

// Flush persists the snapshot if it changed and the debounce window elapsed.
// force bypasses the debounce (used on shutdown).
func (c *termCourseCache) Flush(force bool) {
	if c == nil || c.path == "" {
		return
	}
	c.mu.Lock()
	if !c.dirty || (!force && time.Since(c.lastSave) < termCacheFlushInterval) {
		c.mu.Unlock()
		return
	}
	c.evictLocked()
	raw, err := json.Marshal(c.entries)
	c.dirty = false
	c.lastSave = time.Now()
	c.mu.Unlock()
	if err != nil {
		return
	}
	_ = atomicWrite(c.path, raw, 0o600)
}

// evictLocked drops expired entries, then the least recently used ones until the
// student budget is met. Callers hold c.mu.
func (c *termCourseCache) evictLocked() {
	cutoff := time.Now().Add(-termCacheTTL)
	students := map[string]struct{}{}
	for key, entry := range c.entries {
		if entry.StoredAt.Before(cutoff) {
			delete(c.entries, key)
			continue
		}
		students[termCacheSID(key)] = struct{}{}
	}
	if len(students) <= termCacheMaxStudents {
		return
	}
	// Rank students by their most recent use, then drop the coldest ones whole —
	// evicting single terms would leave students permanently half-cached.
	newest := map[string]time.Time{}
	for key, entry := range c.entries {
		sid := termCacheSID(key)
		if entry.UsedAt.After(newest[sid]) {
			newest[sid] = entry.UsedAt
		}
	}
	ranked := make([]string, 0, len(newest))
	for sid := range newest {
		ranked = append(ranked, sid)
	}
	sort.Slice(ranked, func(i, j int) bool { return newest[ranked[i]].Before(newest[ranked[j]]) })
	drop := map[string]struct{}{}
	for i := 0; i < len(ranked)-termCacheMaxStudents; i++ {
		drop[ranked[i]] = struct{}{}
	}
	for key := range c.entries {
		if _, ok := drop[termCacheSID(key)]; ok {
			delete(c.entries, key)
		}
	}
}

func termCacheSID(key string) string {
	for i := 0; i < len(key); i++ {
		if key[i] == 0 {
			return key[:i]
		}
	}
	return key
}

// Clear empties the cache and the file behind it, for when past-term data is
// known to have changed.
func (c *termCourseCache) Clear() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.entries = map[string]termCacheEntry{}
	c.dirty = true
	c.mu.Unlock()
	c.Flush(true)
}

// Stats reports cache size and hit counters for the admin panel.
func (c *termCourseCache) Stats() (students, terms, hits, misses int) {
	if c == nil {
		return 0, 0, 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	seen := map[string]struct{}{}
	for key := range c.entries {
		seen[termCacheSID(key)] = struct{}{}
	}
	return len(seen), len(c.entries), c.hits, c.misses
}
