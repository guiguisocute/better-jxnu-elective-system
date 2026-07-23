package app

import "testing"

func TestAdminLogInputsAreWhitelisted(t *testing.T) {
	if got := logSource("../../ssh"); got.Unit != "jxnu-backend.service" {
		t.Fatalf("unexpected fallback source: %#v", got)
	}
	if got := boundedLogLines("999999"); got != 300 {
		t.Fatalf("unexpected line fallback: %d", got)
	}
	key, value := logSince("forever")
	if key != "6h" || value != "6 hours ago" {
		t.Fatalf("unexpected since fallback: %q %q", key, value)
	}
}
