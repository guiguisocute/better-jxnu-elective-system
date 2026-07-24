package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseReviewScore(t *testing.T) {
	cases := []struct {
		raw     string
		wantNil bool
		wantErr bool
		want    float64
	}{
		{"", true, false, 0},
		{"0.5", false, false, 0.5},
		{"5", false, false, 5},
		{"3.5", false, false, 3.5},
		{"0.3", false, true, 0},
		{"5.5", false, true, 0},
		{"-1", false, true, 0},
		{"1.2", false, true, 0},
		{"abc", false, true, 0},
	}
	for _, c := range cases {
		got, err := parseReviewScore(c.raw)
		if c.wantErr {
			if err == nil {
				t.Fatalf("parseReviewScore(%q) expected error", c.raw)
			}
			continue
		}
		if err != nil {
			t.Fatalf("parseReviewScore(%q) unexpected error: %v", c.raw, err)
		}
		if c.wantNil {
			if got != nil {
				t.Fatalf("parseReviewScore(%q) = %v, want nil", c.raw, got)
			}
			continue
		}
		v, ok := got.(float64)
		if !ok || v != c.want {
			t.Fatalf("parseReviewScore(%q) = %v, want %v", c.raw, got, c.want)
		}
	}
}

func TestD1Query(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer d1-token" {
			t.Fatalf("authorization = %q", got)
		}
		if !strings.HasSuffix(r.URL.Path, "/d1/database/db-1/query") {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"success":true,"result":[{"results":[{"id":1,"course_id":"028021"}],"success":true,"meta":{"changes":3}}]}`))
	}))
	defer server.Close()

	client := &CloudflarePagesClient{accountID: "acct", apiToken: "d1-token", project: "demo", d1DatabaseID: "db-1", baseURL: server.URL, http: server.Client()}
	rows, changes, err := client.D1Query(context.Background(), "SELECT * FROM reviews WHERE course_id=?", []any{"028021"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["course_id"] != "028021" {
		t.Fatalf("unexpected rows: %#v", rows)
	}
	if changes != 3 {
		t.Fatalf("changes = %d, want 3", changes)
	}
	if gotBody["sql"] != "SELECT * FROM reviews WHERE course_id=?" {
		t.Fatalf("sql body = %v", gotBody["sql"])
	}
	params, ok := gotBody["params"].([]any)
	if !ok || len(params) != 1 || params[0] != "028021" {
		t.Fatalf("params body = %v", gotBody["params"])
	}
}

func TestD1QueryReportsStatementFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"result":[{"results":[],"success":false,"meta":{"changes":0}}]}`))
	}))
	defer server.Close()
	client := &CloudflarePagesClient{accountID: "acct", apiToken: "d1-token", project: "demo", d1DatabaseID: "db-1", baseURL: server.URL, http: server.Client()}
	if _, _, err := client.D1Query(context.Background(), "SELECT 1", nil); err == nil {
		t.Fatal("expected failure when statement success=false")
	}
}

func TestD1QueryNilParamsSendsEmptyArray(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"success":true,"result":[{"results":[],"success":true,"meta":{"changes":0}}]}`))
	}))
	defer server.Close()
	client := &CloudflarePagesClient{accountID: "acct", apiToken: "d1-token", project: "demo", d1DatabaseID: "db-1", baseURL: server.URL, http: server.Client()}
	if _, _, err := client.D1Query(context.Background(), "SELECT 1", nil); err != nil {
		t.Fatal(err)
	}
	params, ok := gotBody["params"].([]any)
	if !ok || len(params) != 0 {
		t.Fatalf("params should be empty array, got %v", gotBody["params"])
	}
}

func TestReviewsPageWithoutD1Credentials(t *testing.T) {
	a := &AdminServer{cloudflare: &CloudflarePagesClient{}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/reviews", nil)
	a.reviewsPage(rec, req, adminSession{CSRF: "x"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "/action/save-d1") || !strings.Contains(body, "连接 Cloudflare D1") {
		t.Fatalf("expected D1 guidance card, got %q", body)
	}
}
