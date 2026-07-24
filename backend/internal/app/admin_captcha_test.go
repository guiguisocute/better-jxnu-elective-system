package app

import (
	"strings"
	"testing"
)

func TestCaptchaCardRendersMutuallyExclusiveProvidersAndScopes(t *testing.T) {
	a := &AdminServer{}
	html := a.captchaCard(adminSession{CSRF: "csrf"}, captchaAdminSettings{
		Provider:           "cap",
		ReviewsEnabled:     true,
		ReportsEnabled:     true,
		StudentEnabled:     true,
		CapAPIEndpoint:     "https://getxk.example/cap",
		CapSiteKey:         "site123",
		CapSecretSet:       true,
		TurnstileSiteKey:   "0xSITE",
		TurnstileSecretSet: true,
	}, nil)
	for _, want := range []string{
		`name="captchaProvider" value="off"`,
		`name="captchaProvider" value="turnstile"`,
		`name="captchaProvider" value="cap" checked`,
		`name="captchaReviews" checked`,
		`name="captchaReports" checked`,
		`name="captchaStudent" checked`,
		"Turnstile / Cap 互斥",
		"评价提交、举报提交、学号查询",
		"/action/save-captcha",
		"/action/captcha-off",
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("captcha card missing %q\n---\n%s", want, html)
		}
	}
	if strings.Contains(html, `value="secret"`) {
		t.Fatal("secret values must never be rendered")
	}
}

func TestCaptchaCardShowsIncompleteSelectedProvider(t *testing.T) {
	a := &AdminServer{}
	html := a.captchaCard(adminSession{}, captchaAdminSettings{
		Provider:       "turnstile",
		ReviewsEnabled: true,
	}, nil)
	if !strings.Contains(html, "配置不完整") || !strings.Contains(html, "403") {
		t.Fatalf("incomplete provider warning missing: %s", html)
	}
}

func TestNormalizeHTTPSURL(t *testing.T) {
	valid := map[string]string{
		"https://getxk.example/cap/":              "https://getxk.example/cap",
		"http://127.0.0.1:3000/":                  "http://127.0.0.1:3000",
		"https://getxk.example/cap/assets/x.wasm": "https://getxk.example/cap/assets/x.wasm",
	}
	for input, want := range valid {
		got, err := normalizeHTTPSURL(input, false)
		if err != nil || got != want {
			t.Fatalf("normalizeHTTPSURL(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{
		"http://example.com/cap",
		"https://user:pass@example.com/cap",
		"https://example.com/cap?secret=x",
		"not-a-url",
	} {
		if _, err := normalizeHTTPSURL(input, false); err == nil {
			t.Fatalf("normalizeHTTPSURL(%q) unexpectedly accepted", input)
		}
	}
	if got, err := normalizeHTTPSURL("", true); err != nil || got != "" {
		t.Fatalf("optional empty URL = %q, %v", got, err)
	}
}
