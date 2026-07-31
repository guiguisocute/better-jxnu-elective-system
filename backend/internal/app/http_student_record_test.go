package app

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const fictitiousStudentID = "999999999999"

func TestDecodeStudentRecordRequestAcceptsJSONBody(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/student-record", strings.NewReader(`{"sid":"`+fictitiousStudentID+`"}`))
	w := httptest.NewRecorder()

	got, err := decodeStudentRecordRequest(w, r)
	if err != nil || got != fictitiousStudentID {
		t.Fatalf("decoded SID = %q, %v; want fictitious request-body SID", got, err)
	}
}

func TestDecodeStudentRecordRequestRejectsUnsafeBodies(t *testing.T) {
	tests := []struct {
		name string
		body io.Reader
	}{
		{name: "missing sid", body: strings.NewReader(`{}`)},
		{name: "non-numeric sid", body: strings.NewReader(`{"sid":"not-a-student"}`)},
		{name: "unknown field", body: strings.NewReader(`{"sid":"` + fictitiousStudentID + `","extra":true}`)},
		{name: "trailing JSON", body: strings.NewReader(`{"sid":"` + fictitiousStudentID + `"}{}`)},
		{name: "too large", body: bytes.NewReader(make([]byte, maxStudentRecordRequestBytes+1))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/student-record", tt.body)
			if _, err := decodeStudentRecordRequest(httptest.NewRecorder(), r); err == nil {
				t.Fatal("unsafe request body was accepted")
			}
		})
	}
}

func TestStudentRecordEndpointRejectsGETQuery(t *testing.T) {
	servers := &Servers{live: &LiveStudentService{env: Environment{LiveSecret: "test-secret"}}}
	r := httptest.NewRequest(http.MethodGet, "/student-record?sid="+fictitiousStudentID, nil)
	r.Header.Set("X-Live-Secret", "test-secret")
	w := httptest.NewRecorder()

	servers.liveHandler().ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("GET response = %d, Allow %q; want 405 and POST", w.Code, w.Header().Get("Allow"))
	}
}

func TestStudentRecordEndpointRejectsQueryOnPOST(t *testing.T) {
	servers := &Servers{live: &LiveStudentService{env: Environment{LiveSecret: "test-secret"}}}
	r := httptest.NewRequest(http.MethodPost, "/student-record?sid="+fictitiousStudentID, strings.NewReader(`{"sid":"`+fictitiousStudentID+`"}`))
	r.Header.Set("X-Live-Secret", "test-secret")
	w := httptest.NewRecorder()

	servers.liveHandler().ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("POST with query response = %d; want 400", w.Code)
	}
}

func TestRedactStudentIDRemovesPlainAndEncodedValues(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte(fictitiousStudentID))
	got := redactStudentID("sid="+fictitiousStudentID+" UserNum="+encoded, fictitiousStudentID)
	if strings.Contains(got, fictitiousStudentID) || strings.Contains(got, encoded) {
		t.Fatalf("redacted message still contains a recoverable student ID: %q", got)
	}
	if masked := maskedStudentID(fictitiousStudentID); masked != "9999****" {
		t.Fatalf("masked SID = %q", masked)
	}
}
