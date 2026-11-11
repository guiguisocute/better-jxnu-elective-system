package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func assertMinimalHealthResponse(t *testing.T, handler http.Handler, wantStatus int, wantOK bool) {
	t.Helper()
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if w.Code != wantStatus {
		t.Fatalf("health status = %d, want %d", w.Code, wantStatus)
	}
	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if len(payload) != 1 || payload["ok"] != wantOK {
		t.Fatalf("health response = %#v, want only ok=%v", payload, wantOK)
	}
}

func TestPublicHealthReportsStartingWithoutFailure(t *testing.T) {
	servers := &Servers{enrollment: &EnrollmentService{}}
	w := httptest.NewRecorder()
	servers.publicHandler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || payload["status"] != "starting" || payload["ok"] != true {
		t.Fatalf("startup health = %d %#v", w.Code, payload)
	}
}

func TestLiveHealthResponseIsMinimal(t *testing.T) {
	servers := &Servers{live: &LiveStudentService{env: Environment{XKUsername: "configured", XKPassword: "configured"}}}
	assertMinimalHealthResponse(t, servers.liveHandler(), http.StatusOK, true)
}

func TestLiveHealthAcceptsTunnelPrefix(t *testing.T) {
	servers := &Servers{live: &LiveStudentService{env: Environment{XKUsername: "configured", XKPassword: "configured"}}}
	w := httptest.NewRecorder()
	servers.liveHandler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/live/healthz", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("prefixed health status = %d, want %d", w.Code, http.StatusOK)
	}
}
