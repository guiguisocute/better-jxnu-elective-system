package app

import (
	"strings"
	"testing"
)

// TestTurnstileCardStates drives the reviews-page card renderer and asserts the
// observable HTML for each configuration state — the real "does it show the
// right switch" check. Pure render: state comes straight from the two args.
func TestTurnstileCardStates(t *testing.T) {
	session := adminSession{CSRF: "csrf-token"}
	a := &AdminServer{}

	t.Run("both set = enabled", func(t *testing.T) {
		html := a.turnstileCard(session, "0xSITE", true)
		mustContain(t, html, "已启用")
		mustContain(t, html, "/action/save-turnstile")
		mustContain(t, html, "/action/turnstile-off") // off switch present when configured
		mustContain(t, html, `value="0xSITE"`)        // site key prefilled
	})

	t.Run("only site key = incomplete", func(t *testing.T) {
		html := a.turnstileCard(session, "0xSITE", false)
		mustContain(t, html, "配置不完整")
		mustContain(t, html, "/action/turnstile-off") // can clear the half state
	})

	t.Run("only secret = incomplete", func(t *testing.T) {
		html := a.turnstileCard(session, "", true)
		mustContain(t, html, "配置不完整")
		mustContain(t, html, "/action/turnstile-off")
	})

	t.Run("none = not enabled, no off switch", func(t *testing.T) {
		html := a.turnstileCard(session, "", false)
		mustContain(t, html, "未启用")
		if strings.Contains(html, "/action/turnstile-off") {
			t.Fatal("off switch must not render when nothing is configured")
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
