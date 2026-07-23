package app

import (
	"net/http"
	"testing"
)

func TestApplyLegacyJWCCookiesKeepsCommaUnquoted(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, jwcBase+"/MyControl/All_Display.aspx", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "ASP.NET_SessionId", Value: "session"})
	req.AddCookie(&http.Cookie{Name: authCookie, Value: "legacy,value"})
	if got := req.Header.Get("Cookie"); got != `ASP.NET_SessionId=session; SjdJsfJfXfsFsdf="legacy,value"` {
		t.Fatalf("test precondition changed: standard Cookie header = %q", got)
	}
	if err := applyLegacyJWCCookies(req); err != nil {
		t.Fatal(err)
	}
	if got, want := req.Header.Get("Cookie"), "ASP.NET_SessionId=session; SjdJsfJfXfsFsdf=legacy,value"; got != want {
		t.Fatalf("legacy Cookie header = %q, want %q", got, want)
	}
}

func TestApplyLegacyJWCCookiesDoesNotTouchOtherHosts(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://example.com/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "token", Value: "a,b"})
	before := req.Header.Get("Cookie")
	if err := applyLegacyJWCCookies(req); err != nil {
		t.Fatal(err)
	}
	if got := req.Header.Get("Cookie"); got != before {
		t.Fatalf("other host Cookie changed from %q to %q", before, got)
	}
}
