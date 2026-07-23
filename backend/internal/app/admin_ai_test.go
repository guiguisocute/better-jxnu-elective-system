package app

import (
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseAIAdminSettings(t *testing.T) {
	form := url.Values{
		"aiBaseURL":      {"https://api.example.com/v1/"},
		"aiModel":        {"model-a"},
		"aiSystemPrompt": {defaultAIInstruction},
		"aiTemperature":  {"0.4"},
		"aiMaxTokens":    {"1800"},
		"aiTimeout":      {"45"},
		"aiVoterDaily":   {"12"},
		"aiSiteCalls":    {"400"},
		"aiSiteTokens":   {"3000000"},
		"aiAPIKey":       {"secret"},
	}
	r := httptest.NewRequest("POST", "/action/save-ai", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if err := r.ParseForm(); err != nil {
		t.Fatal(err)
	}
	got, err := parseAIAdminSettings(r)
	if err != nil {
		t.Fatal(err)
	}
	if got.BaseURL != "https://api.example.com/v1" || got.Model != "model-a" || got.Temperature != "0.4" || got.MaxTokens != 1800 {
		t.Fatalf("unexpected settings: %#v", got)
	}
}

func TestUpdateEnvironmentFilePreservesUnrelatedValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backend.env")
	if err := os.WriteFile(path, []byte("ADMIN_PASSWORD=keep\nCF_ACCOUNT_ID=\nCF_API_TOKEN=old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := updateEnvironmentFile(path, map[string]string{
		"CF_ACCOUNT_ID": "0123456789abcdef0123456789abcdef",
		"CF_API_TOKEN":  "new-token",
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(raw)
	for _, want := range []string{"ADMIN_PASSWORD=keep\n", "CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef\n", "CF_API_TOKEN=new-token\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
}

func TestParseAIAdminSettingsRejectsEndpointURL(t *testing.T) {
	form := url.Values{
		"aiBaseURL": {"https://api.example.com/v1/chat/completions"},
		"aiModel":   {"model-a"}, "aiSystemPrompt": {defaultAIInstruction}, "aiTemperature": {"0.3"},
		"aiMaxTokens": {"1500"}, "aiTimeout": {"60"}, "aiVoterDaily": {"10"},
		"aiSiteCalls": {"300"}, "aiSiteTokens": {"2000000"},
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	_ = r.ParseForm()
	if _, err := parseAIAdminSettings(r); err == nil {
		t.Fatal("expected endpoint URL to be rejected")
	}
}
