package app

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestValidateDeploymentOrigin(t *testing.T) {
	valid := []string{"https://xk.example.edu", "https://sub.domain.example.edu", "http://localhost:5173", "http://127.0.0.1:5173"}
	for _, value := range valid {
		if err := validateDeploymentOrigin(value); err != nil {
			t.Errorf("%q should be valid: %v", value, err)
		}
	}
	invalid := map[string]string{
		"":                              "empty",
		"xk.example.edu":                "missing scheme",
		"http://xk.example.edu":         "plain http on a public host",
		"https://xk.example.edu/path":   "carries a path",
		"https://xk.example.edu?a=1":    "carries a query",
		"https://u:p@xk.example.edu":    "carries credentials",
		"https://xk.example.edu#anchor": "carries a fragment",
	}
	for value, why := range invalid {
		if err := validateDeploymentOrigin(value); err == nil {
			t.Errorf("%q should be rejected (%s)", value, why)
		}
	}
	// A trailing slash is normalized away so the stored value compares equal to
	// the browser's Origin header byte-for-byte.
	if got := NormalizeDeploymentOrigin("https://xk.example.edu/"); got != "https://xk.example.edu" {
		t.Errorf("NormalizeDeploymentOrigin = %q", got)
	}
}

// An install upgraded from v5 must not have to retype its domain: its CORS
// allowlist already states it. Loopback entries are not the site origin.
func TestConfigMigrationV5AdoptsSiteOriginFromAllowlist(t *testing.T) {
	path := t.TempDir() + "/config.json"
	cfg := DefaultRuntimeConfig()
	cfg.Version = 5
	cfg.AllowedOrigins = []string{"http://localhost:5173", "https://xk.example.edu", "https://other.example"}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	got := store.Get()
	if got.Version != 6 {
		t.Fatalf("version = %d, want 6", got.Version)
	}
	if got.SiteOrigin != "https://xk.example.edu" {
		t.Fatalf("siteOrigin = %q, want the first non-loopback allowlist entry", got.SiteOrigin)
	}
	// Migration must never drop an operator's existing allowlist.
	if len(got.AllowedOrigins) != 3 {
		t.Fatalf("allowedOrigins = %#v", got.AllowedOrigins)
	}
}

func TestConfigMigrationV5WithOnlyLoopbackOriginsLeavesSiteOriginEmpty(t *testing.T) {
	path := t.TempDir() + "/config.json"
	cfg := DefaultRuntimeConfig()
	cfg.Version = 5
	cfg.AllowedOrigins = []string{"http://localhost:5173", "http://127.0.0.1:5173"}
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get().SiteOrigin; got != "" {
		t.Fatalf("siteOrigin = %q, want empty (a dev-only allowlist says nothing about the site)", got)
	}
}

// The defaults must not name any particular deployment: that is exactly what
// made a fork silently point at the upstream author's infrastructure.
func TestDefaultsCarryNoUpstreamIdentity(t *testing.T) {
	cfg := DefaultRuntimeConfig()
	if cfg.SiteOrigin != "" || cfg.BackendPublicURL != "" {
		t.Fatalf("defaults must not name a deployment: %q / %q", cfg.SiteOrigin, cfg.BackendPublicURL)
	}
	for _, origin := range cfg.AllowedOrigins {
		if !strings.Contains(origin, "localhost") && !strings.Contains(origin, "127.0.0.1") {
			t.Errorf("default CORS allowlist must be local-only, found %q", origin)
		}
	}
	t.Setenv("CF_PAGES_PROJECT", "")
	t.Setenv("CF_D1_DATABASE_ID", "")
	env := LoadEnvironment()
	if env.CFPagesProject != "" || env.CFD1DatabaseID != "" {
		t.Fatalf("Cloudflare resource ids must have no built-in default: %q / %q", env.CFPagesProject, env.CFD1DatabaseID)
	}
}

// The wiring card is the fork's copy-paste source; it must reflect the operator's
// own backend, never a baked-in host.
func TestFrontendWiringCardUsesConfiguredBackend(t *testing.T) {
	cfg := DefaultRuntimeConfig()
	if got := frontendWiringCard(cfg); !strings.Contains(got, "填好上面的「后端对外地址」") {
		t.Fatalf("unset backend should prompt, got: %s", got)
	}
	cfg.BackendPublicURL = "https://getxk.example.edu"
	card := frontendWiringCard(cfg)
	for _, want := range []string{
		"VITE_KKAP_API_URL=https://getxk.example.edu/api/enrollments",
		"VITE_BACKEND_CONFIG_URL=https://getxk.example.edu/api/config",
		"LIVE_URL = &#34;https://getxk.example.edu/live/student-record&#34;",
		"getxk.example.edu {",
	} {
		if !strings.Contains(card, want) {
			t.Errorf("wiring card missing %q", want)
		}
	}
	if strings.Contains(card, "jxnu-publish.asia") {
		t.Error("wiring card leaked the upstream author's domain")
	}
}
