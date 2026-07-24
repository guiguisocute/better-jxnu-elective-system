package app

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"time"
)

// reviewNameTTL bounds how long resolved course/teacher names are cached before
// the master JSON files are re-read.
const reviewNameTTL = 10 * time.Minute

// reviewNameCache holds id → display-name maps resolved from data/master.
type reviewNameCache struct {
	courses  map[string]string
	teachers map[string]string
}

// reviewDimMeta drives the card visualization for one rating dimension: a short
// chip label, its accent color, and the five star-tier phrases (index 0 = 1★).
type reviewDimMeta struct {
	Score   string
	Comment string
	Chip    string
	Color   string
	Tiers   [5]string
}

// reviewDimMetas mirrors reviewDimensions order; both describe the same five D1
// columns. Kept separate so the edit form (reviewDimensions) stays minimal.
var reviewDimMetas = []reviewDimMeta{
	{"overall", "overall_c", "总体", "#DC2626", [5]string{"很差", "较差", "一般", "不错", "强烈推荐"}},
	{"assess", "assess_c", "考核", "#EA580C", [5]string{"给分很低", "给分偏严", "中规中矩", "给分不错", "给分超好"}},
	{"attendance", "attendance_c", "考勤", "#2563EB", [5]string{"每堂必点", "经常点名", "偶尔点名", "很少点名", "一次未点"}},
	{"difficulty", "difficulty_c", "强度", "#7C3AED", [5]string{"毫无压力", "比较简单", "中等", "有点强度", "硬核劝退"}},
	{"teaching", "teaching_c", "教学", "#059669", [5]string{"照本宣科", "比较平淡", "还算清晰", "讲得很好", "醍醐灌顶"}},
}

// starTier maps a 0.5–5 score to a 1–5 tier by rounding (四舍五入取档), clamped.
func starTier(score float64) int {
	tier := int(math.Round(score))
	if tier < 1 {
		tier = 1
	}
	if tier > 5 {
		tier = 5
	}
	return tier
}

// starTierLabel returns the phrase for a dimension's rounded score tier.
func (d reviewDimMeta) starTierLabel(score float64) string {
	return d.Tiers[starTier(score)-1]
}

// reviewNames returns lookups for course and teacher display names, backed by a
// 10-minute cache. On any read/parse failure the maps are empty, so callers fall
// back to raw ids and the page never crashes.
func (a *AdminServer) reviewNames() (courseName func(id string) string, teacherName func(id string) string) {
	a.namesMu.Lock()
	defer a.namesMu.Unlock()
	if a.nameCache == nil || time.Since(a.namesAt) > reviewNameTTL {
		a.nameCache = a.loadReviewNames()
		a.namesAt = time.Now()
	}
	cache := a.nameCache
	lookup := func(m map[string]string) func(string) string {
		return func(id string) string { return m[id] }
	}
	return lookup(cache.courses), lookup(cache.teachers)
}

func (a *AdminServer) loadReviewNames() *reviewNameCache {
	master := filepath.Join(a.env.RepoDir, "data", "master")
	return &reviewNameCache{
		courses:  loadIDNameMap(filepath.Join(master, "courses.json")),
		teachers: loadIDNameMap(filepath.Join(master, "teachers.json")),
	}
}

// loadIDNameMap reads a `[{"id":..,"name":..}, ..]` JSON array (extra fields
// ignored) into an id→name map. Missing/invalid files yield an empty map.
func loadIDNameMap(path string) map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var items []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &items); err != nil {
		return out
	}
	for _, item := range items {
		if item.ID != "" {
			out[item.ID] = item.Name
		}
	}
	return out
}
