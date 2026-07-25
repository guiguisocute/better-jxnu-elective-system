package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTermCourseCacheRoundTripsAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "student_terms.json")
	cache := newTermCourseCache(path)

	courses := []DetailCourse{{CourseNo: "259772", CourseName: "数据结构", Teacher: "张三"}}
	cache.Put("2022123456", "2024-1", courses)
	got, ok := cache.Get("2022123456", "2024-1")
	if !ok || len(got) != 1 || got[0].CourseNo != "259772" {
		t.Fatalf("Get after Put = %#v, %v", got, ok)
	}
	if _, ok := cache.Get("2022123456", "2025-1"); ok {
		t.Fatal("a term that was never stored must miss")
	}
	if _, ok := cache.Get("9999999999", "2024-1"); ok {
		t.Fatal("another student must not read this student's terms")
	}

	cache.Flush(true)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("cache file not written: %v", err)
	}
	// A restart must not lose past terms — that is the whole point of persisting.
	reloaded := newTermCourseCache(path)
	got, ok = reloaded.Get("2022123456", "2024-1")
	if !ok || len(got) != 1 || got[0].CourseName != "数据结构" {
		t.Fatalf("reload lost the entry: %#v, %v", got, ok)
	}
}

func TestTermCourseCacheClearAndExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "student_terms.json")
	cache := newTermCourseCache(path)
	cache.Put("2022123456", "2024-1", []DetailCourse{{CourseNo: "1"}})
	cache.Clear()
	if _, ok := cache.Get("2022123456", "2024-1"); ok {
		t.Fatal("Clear must drop entries (it is the escape hatch for corrected grades)")
	}

	// An entry older than the TTL must not be served.
	cache.mu.Lock()
	cache.entries[termCacheKey("2022123456", "2020-1")] = termCacheEntry{
		Courses:  []DetailCourse{{CourseNo: "2"}},
		StoredAt: time.Now().Add(-termCacheTTL - time.Hour),
	}
	cache.mu.Unlock()
	if _, ok := cache.Get("2022123456", "2020-1"); ok {
		t.Fatal("expired entry must miss")
	}
}

// Eviction drops whole students, never individual terms: a half-cached student
// would keep paying for the terms that got dropped while looking cached.
func TestTermCourseCacheEvictsWholeStudents(t *testing.T) {
	cache := newTermCourseCache("")
	base := time.Now().Add(-time.Hour)
	for i := 0; i < termCacheMaxStudents+50; i++ {
		sid := "sid" + string(rune('a'+i%26)) + itoa(i)
		for _, term := range []string{"t1", "t2", "t3"} {
			cache.entries[termCacheKey(sid, term)] = termCacheEntry{
				Courses:  []DetailCourse{{CourseNo: "1"}},
				StoredAt: time.Now(),
				UsedAt:   base.Add(time.Duration(i) * time.Second),
			}
		}
	}
	cache.mu.Lock()
	cache.evictLocked()
	cache.mu.Unlock()

	students, _, _, _ := cache.Stats()
	if students > termCacheMaxStudents {
		t.Fatalf("students = %d, want <= %d", students, termCacheMaxStudents)
	}
	perStudent := map[string]int{}
	for key := range cache.entries {
		perStudent[termCacheSID(key)]++
	}
	for sid, n := range perStudent {
		if n != 3 {
			t.Fatalf("student %s kept %d terms, want all 3 or none", sid, n)
		}
	}
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var out []byte
	for v > 0 {
		out = append([]byte{byte('0' + v%10)}, out...)
		v /= 10
	}
	return string(out)
}
