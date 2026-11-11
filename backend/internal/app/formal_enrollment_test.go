package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFormalEnrollmentIndependentOfDefaultStage(t *testing.T) {
	cfg := DefaultRuntimeConfig()
	cfg.PreselectSemester, cfg.SelectionSemester = "2027-03", "2026-09"
	for _, stage := range []string{"pre", "formal"} {
		cfg.DefaultDataSource = stage
		if got := cfg.LiveEnrollmentTarget(); got != "2026-09" {
			t.Fatalf("%s target = %s", stage, got)
		}
	}
	cfg.DefaultDataSource = "pre"
	store := &ConfigStore{cfg: cfg}
	service := &EnrollmentService{config: store}
	service.finishAttempt(&EnrollmentSnapshot{Version: 1, Semester: "2026-09", FetchedAt: time.Now().UTC().Format(time.RFC3339), ClassCount: 1, Items: []EnrollmentItem{{"课程", "班级", "教师", 3}}}, nil, time.Now().Add(time.Minute), 30)
	servers := &Servers{config: store, enrollment: service}
	for _, path := range []string{"/api/config", "/api/enrollments", "/healthz"} {
		w := httptest.NewRecorder()
		servers.publicHandler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s status = %d: %s", path, w.Code, w.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if path == "/api/config" {
			if payload["defaultDataSource"] != "pre" || payload["liveEnrollmentSemester"] != "2026-09" {
				t.Fatal(payload)
			}
		} else if payload["semester"] != "2026-09" {
			t.Fatal(payload)
		}
	}
}

func TestEnrollmentHealthDistinguishesPausedFailureAndStaleness(t *testing.T) {
	for _, tc := range []struct {
		name   string
		target string
		age    time.Duration
		failed bool
		want   string
		status int
	}{
		{"paused", "", 0, false, "paused", 200},
		{"starting", "2026-09", 0, false, "starting", 200},
		{"fresh", "2026-09", time.Second, false, "ok", 200},
		{"expired", "2026-09", 5 * time.Minute, false, "stale", 503},
		{"failed_with_recent_snapshot", "2026-09", time.Second, true, "error", 503},
		{"failed_without_snapshot", "2026-09", 0, true, "error", 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := DefaultRuntimeConfig()
			cfg.DefaultDataSource = "pre"
			cfg.SelectionSemester = tc.target
			cfg.EnrollmentRefreshSeconds = 30
			service := &EnrollmentService{config: &ConfigStore{cfg: cfg}}
			if tc.age > 0 {
				service.state.Snapshot = &EnrollmentSnapshot{Semester: tc.target, FetchedAt: time.Now().Add(-tc.age).UTC().Format(time.RFC3339)}
			}
			if tc.failed {
				text := errors.New("private upstream URL and secret must not leak").Error()
				service.state.Error = &text
			}
			servers := &Servers{enrollment: service}
			w := httptest.NewRecorder()
			servers.publicHandler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
			var payload map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if w.Code != tc.status || payload["status"] != tc.want || payload["semester"] != tc.target {
				t.Fatalf("health %d: %#v", w.Code, payload)
			}
			if _, ok := payload["lastSuccessAt"]; !ok {
				t.Fatal("lastSuccessAt missing")
			}
			if tc.status == http.StatusServiceUnavailable {
				request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
				request.Header.Set("If-None-Match", w.Header().Get("ETag"))
				cached := httptest.NewRecorder()
				servers.publicHandler().ServeHTTP(cached, request)
				if cached.Code != http.StatusServiceUnavailable {
					t.Fatalf("cached failure became %d", cached.Code)
				}
			}
			if strings.Contains(w.Body.String(), "private upstream") {
				t.Fatal("raw error leaked")
			}
		})
	}
}
