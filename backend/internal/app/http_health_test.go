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

func TestPublicHealthResponseIsMinimal(t *testing.T) {
	servers := &Servers{enrollment: &EnrollmentService{}}
	assertMinimalHealthResponse(t, servers.publicHandler(), http.StatusServiceUnavailable, false)
}

func TestLiveHealthResponseIsMinimal(t *testing.T) {
	servers := &Servers{live: &LiveStudentService{env: Environment{XKUsername: "configured", XKPassword: "configured"}}}
	assertMinimalHealthResponse(t, servers.liveHandler(), http.StatusOK, true)
}
