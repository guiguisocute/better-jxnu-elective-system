package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// d1TestServer answers /query by echoing the bound params back as a row, and
// reports the peak number of simultaneously in-flight requests.
func d1TestServer(t *testing.T, delay time.Duration) (*httptest.Server, *int32) {
	t.Helper()
	var inFlight, peak int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := atomic.AddInt32(&inFlight, 1)
		for {
			seen := atomic.LoadInt32(&peak)
			if current <= seen || atomic.CompareAndSwapInt32(&peak, seen, current) {
				break
			}
		}
		defer atomic.AddInt32(&inFlight, -1)
		time.Sleep(delay)

		raw, _ := io.ReadAll(r.Body)
		var body struct {
			SQL    string `json:"sql"`
			Params []any  `json:"params"`
		}
		_ = json.Unmarshal(raw, &body)
		row := map[string]any{"sql": body.SQL}
		if len(body.Params) > 0 {
			row["first"] = body.Params[0]
		}
		payload, _ := json.Marshal(map[string]any{
			"success": true,
			"result":  []any{map[string]any{"success": true, "results": []any{row}, "meta": map[string]any{"changes": 1}}},
		})
		_, _ = w.Write(payload)
	}))
	t.Cleanup(server.Close)
	return server, &peak
}

func newD1TestClient(server *httptest.Server) *CloudflarePagesClient {
	return &CloudflarePagesClient{
		accountID: "account", apiToken: "test-token", project: "demo", d1DatabaseID: "db",
		baseURL: server.URL, http: server.Client(),
	}
}

// D1Many must keep results aligned with the statements that produced them —
// callers index into the slice positionally, so a shuffle would silently show
// one query's rows under another's heading.
func TestD1ManyKeepsResultsPositional(t *testing.T) {
	server, _ := d1TestServer(t, 0)
	client := newD1TestClient(server)

	statements := make([]D1Statement, 12)
	for i := range statements {
		statements[i] = D1Statement{SQL: "SELECT ?", Params: []any{float64(i)}}
	}
	results := client.D1Many(context.Background(), statements)
	if len(results) != len(statements) {
		t.Fatalf("len(results) = %d, want %d", len(results), len(statements))
	}
	for i, result := range results {
		if result.Err != nil {
			t.Fatalf("statement %d: %v", i, result.Err)
		}
		if len(result.Rows) != 1 {
			t.Fatalf("statement %d returned %d rows", i, len(result.Rows))
		}
		if got := result.Rows[0]["first"]; got != float64(i) {
			t.Fatalf("statement %d got param %v, want %d", i, got, i)
		}
		if result.Changes != 1 {
			t.Fatalf("statement %d changes = %d", i, result.Changes)
		}
	}
}

// The whole point of D1Many is that N statements cost about one round trip
// instead of N. Verify they really overlap and stay within the concurrency cap.
func TestD1ManyRunsConcurrentlyWithinCap(t *testing.T) {
	const delay = 40 * time.Millisecond
	server, peak := d1TestServer(t, delay)
	client := newD1TestClient(server)

	statements := make([]D1Statement, d1MaxConcurrency*2)
	for i := range statements {
		statements[i] = D1Statement{SQL: "SELECT 1"}
	}
	start := time.Now()
	results := client.D1Many(context.Background(), statements)
	elapsed := time.Since(start)

	if err := firstD1Error(results); err != nil {
		t.Fatal(err)
	}
	// Sequential would be 16 * 40ms = 640ms; two capped waves are ~80ms.
	if elapsed > delay*time.Duration(len(statements))/2 {
		t.Fatalf("D1Many took %v for %d statements — statements are not overlapping", elapsed, len(statements))
	}
	if got := atomic.LoadInt32(peak); got > d1MaxConcurrency {
		t.Fatalf("peak concurrency = %d, exceeds cap %d", got, d1MaxConcurrency)
	}
}

// One bad statement must not hide the others: the page still renders what it
// can, and firstD1Error reports the failure.
func TestD1ManyIsolatesPerStatementErrors(t *testing.T) {
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			SQL string `json:"sql"`
		}
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		defer mu.Unlock()
		if body.SQL == "BOOM" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":7500,"message":"no such table"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"result":[{"success":true,"results":[{"ok":1}],"meta":{"changes":0}}]}`))
	}))
	defer server.Close()

	results := newD1TestClient(server).D1Many(context.Background(), []D1Statement{
		{SQL: "SELECT 1"}, {SQL: "BOOM"}, {SQL: "SELECT 2"},
	})
	if results[0].Err != nil || results[2].Err != nil {
		t.Fatalf("healthy statements should still succeed: %v / %v", results[0].Err, results[2].Err)
	}
	if results[1].Err == nil {
		t.Fatal("failing statement should report an error")
	}
	if firstD1Error(results) == nil {
		t.Fatal("firstD1Error should surface the failure")
	}
	if d1Rows(results, 1) != nil {
		t.Fatal("d1Rows must return nil for a failed statement")
	}
	if d1Rows(results, 99) != nil {
		t.Fatal("d1Rows must return nil for an out-of-range index")
	}
	if len(d1Rows(results, 0)) != 1 {
		t.Fatal("d1Rows should return rows for a healthy statement")
	}
}
