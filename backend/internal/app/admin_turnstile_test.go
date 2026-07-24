package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestDeleteProductionEnvSendsNull verifies the Turnstile off switch deletes
// keys the way Cloudflare requires: each key present in env_vars with a literal
// JSON null value. A missing key would *preserve* the variable, so asserting on
// the decoded map alone is not enough — we assert the raw body contains null.
func TestDeleteProductionEnvSendsNull(t *testing.T) {
	var rawBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Fatalf("unexpected method %s", r.Method)
		}
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		rawBody = buf.Bytes()
		_, _ = w.Write([]byte(`{"success":true,"result":{"name":"demo"}}`))
	}))
	defer server.Close()

	client := &CloudflarePagesClient{
		accountID: "account", apiToken: "test-token", project: "demo",
		baseURL: server.URL, http: server.Client(),
	}
	if err := client.DeleteProductionEnv(context.Background(), []string{turnstileSiteKeyEnv, turnstileSecretEnv}); err != nil {
		t.Fatal(err)
	}

	var payload map[string]any
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		t.Fatalf("body not JSON: %v (%s)", err, rawBody)
	}
	envVars := payload["deployment_configs"].(map[string]any)["production"].(map[string]any)["env_vars"].(map[string]any)
	for _, key := range []string{turnstileSiteKeyEnv, turnstileSecretEnv} {
		val, present := envVars[key]
		if !present {
			t.Fatalf("%s missing from env_vars — a missing key preserves the var instead of deleting it", key)
		}
		if val != nil {
			t.Fatalf("%s must be JSON null to delete, got %#v", key, val)
		}
	}
}

func TestDeleteProductionEnvRejectsEmpty(t *testing.T) {
	client := &CloudflarePagesClient{accountID: "a", apiToken: "t", project: "p", baseURL: "http://example.invalid", http: http.DefaultClient}
	if err := client.DeleteProductionEnv(context.Background(), nil); err == nil {
		t.Fatal("expected error for empty key list")
	}
}

// TestTurnstileCardStates drives the reviews-page card renderer against a mock
// Pages backend and asserts the observable HTML for each configuration state —
// the real "does it show the right switch" check, not just unit logic.
func TestTurnstileCardStates(t *testing.T) {
	session := adminSession{CSRF: "csrf-token"}

	cardFor := func(t *testing.T, envVarsJSON string) string {
		t.Helper()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"success":true,"result":{"name":"demo","deployment_configs":{"production":{"env_vars":` + envVarsJSON + `}}}}`))
		}))
		t.Cleanup(server.Close)
		a := &AdminServer{cloudflare: &CloudflarePagesClient{
			accountID: "account", apiToken: "test-token", project: "demo",
			baseURL: server.URL, http: server.Client(),
		}}
		return a.turnstileCard(session)
	}

	t.Run("both set = enabled", func(t *testing.T) {
		html := cardFor(t, `{"TURNSTILE_SITE_KEY":{"type":"plain_text","value":"0xSITE"},"TURNSTILE_SECRET":{"type":"secret_text"}}`)
		mustContain(t, html, "已启用")
		mustContain(t, html, "/action/save-turnstile")
		mustContain(t, html, "/action/turnstile-off") // off switch present when configured
		mustContain(t, html, "value=\"0xSITE\"")      // site key prefilled
	})

	t.Run("only site key = incomplete", func(t *testing.T) {
		html := cardFor(t, `{"TURNSTILE_SITE_KEY":{"type":"plain_text","value":"0xSITE"}}`)
		mustContain(t, html, "配置不完整")
		mustContain(t, html, "/action/turnstile-off") // can clear the half state
	})

	t.Run("none = not enabled, no off switch", func(t *testing.T) {
		html := cardFor(t, `{}`)
		mustContain(t, html, "未启用")
		if strings.Contains(html, "/action/turnstile-off") {
			t.Fatal("off switch must not render when nothing is configured")
		}
	})

	t.Run("pages not ready points to /ai", func(t *testing.T) {
		a := &AdminServer{cloudflare: &CloudflarePagesClient{accountID: "", apiToken: "", project: ""}}
		html := a.turnstileCard(session)
		mustContain(t, html, "/ai")
		if strings.Contains(html, "/action/save-turnstile") {
			t.Fatal("must not render the save form when Pages is not connected")
		}
	})
}

func mustContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Fatalf("expected HTML to contain %q\n---\n%s", needle, haystack)
	}
}

func TestValidTurnstileKey(t *testing.T) {
	cases := []struct {
		name string
		key  string
		max  int
		want bool
	}{
		{"typical site key", "0x4AAAAAAABkMYinukE8nzYS", 120, true},
		{"empty", "", 120, false},
		{"too long", string(make([]byte, 130)), 120, false},
		{"has space", "0x4AAA AAAB", 120, false},
		{"has newline", "0x4AAA\nAAAB", 120, false},
		{"has tab", "0x4AAA\tAAAB", 120, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := validTurnstileKey(c.key, c.max); got != c.want {
				t.Fatalf("validTurnstileKey(%q) = %v, want %v", c.key, got, c.want)
			}
		})
	}
}
