package app

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestEnrollmentServiceLoadsRecentMatchingSnapshot(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenConfigStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := EnrollmentSnapshot{
		Version: 1, Semester: store.Get().LiveEnrollmentTarget(),
		FetchedAt: time.Now().UTC().Format(time.RFC3339), SourceRows: 2,
		ClassCount: 1, Items: []EnrollmentItem{{"课程", "班级", "教师", 3}},
	}
	if err := WriteJSON(filepath.Join(dir, "enrollment_snapshot.json"), snapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service := NewEnrollmentService(store, logger)
	_, _, ok := service.Responses()
	if !ok {
		t.Fatal("recent matching snapshot was not loaded")
	}
	if got := service.Status().Snapshot; got == nil || got.ClassCount != 1 {
		t.Fatalf("loaded snapshot = %#v", got)
	}
}

func TestParseSchoolTermOptions(t *testing.T) {
	doc, err := parseHTML(`<select name="ddlSterm"><option value="2026/9/1 0:00:00">26-27第1学期</option><option value="2027/3/1 0:00:00">26-27第2学期</option></select>`)
	if err != nil {
		t.Fatal(err)
	}
	got := parseSchoolTermOptions(doc)
	want := []SchoolTermOption{
		{Label: "26-27第1学期", Value: "2026/9/1 0:00:00", Semester: "2026-09"},
		{Label: "26-27第2学期", Value: "2027/3/1 0:00:00", Semester: "2027-03"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("options = %#v", got)
	}
}

func TestValidateScheduleSemester(t *testing.T) {
	rows := []ScheduleRow{{RawSemester: "2027/3/1 0:00:00"}, {RawSemester: "2027/3/1 0:00:00"}}
	if err := validateScheduleSemester(rows, "2027-03"); err != nil {
		t.Fatal(err)
	}
	rows[1].RawSemester = "2026/9/1 0:00:00"
	if err := validateScheduleSemester(rows, "2027-03"); err == nil {
		t.Fatal("mixed-semester response accepted")
	}
}

func TestFormalScheduleFingerprintIgnoresEnrollmentAndOrder(t *testing.T) {
	a := []ScheduleRow{
		{CourseID: "2", ClassID: "b", Teacher: "乙", RawSemester: "2027/3/1 0:00:00", EnrolledText: "10", Sequence: "1"},
		{CourseID: "1", ClassID: "a", Teacher: "甲", RawSemester: "2027/3/1 0:00:00", EnrolledText: "20", Sequence: "2"},
	}
	b := []ScheduleRow{
		{CourseID: "1", ClassID: "a", Teacher: "甲", RawSemester: "2027/3/1 0:00:00", EnrolledText: "99", Sequence: "1"},
		{CourseID: "2", ClassID: "b", Teacher: "乙", RawSemester: "2027/3/1 0:00:00", EnrolledText: "88", Sequence: "2"},
	}
	if formalScheduleFingerprint(a) != formalScheduleFingerprint(b) {
		t.Fatal("non-structural changes altered the fingerprint")
	}
}

// hangingTransport 模拟「路由没了、包发出去没人应」：一直挂到请求自己的 ctx 到期。
// 用 RoundTripper 而不是 httptest，是因为 kkapURL 写死在包里，测试没法改它的地址。
type hangingTransport struct{}

func (hangingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	<-request.Context().Done()
	return nil, request.Context().Err()
}

// 打开表单页那一步必须有自己的短预算。2026-09-03 网口闪断时它跟着整份 9MB 课表
// 用了 300 秒的 client.Timeout，5 秒一轮的采集因此 5 分钟没吭一声。
func TestFetchPublicScheduleBoundsFormPageOpen(t *testing.T) {
	original := publicScheduleOpenTimeout
	publicScheduleOpenTimeout = 50 * time.Millisecond
	t.Cleanup(func() { publicScheduleOpenTimeout = original })

	client := &http.Client{Transport: hangingTransport{}, Timeout: publicScheduleTimeout}
	started := time.Now()
	_, err := FetchPublicSchedule(context.Background(), client, "2026-09")
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("hanging form page did not produce an error")
	}
	if !strings.Contains(err.Error(), "打开 Public_Kkap") {
		t.Fatalf("error did not come from the form-page open: %v", err)
	}
	// 宽松到秒级即可：这里要守的是「没有退回 client.Timeout 的 300 秒」，
	// 不是精确的 50ms，免得在忙碌的 CI 上变成随机失败。
	if elapsed > 5*time.Second {
		t.Fatalf("form-page open was not bounded by its own timeout: %v", elapsed)
	}
}

func TestEnrollmentServiceRejectsOtherSemesterSnapshot(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenConfigStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := EnrollmentSnapshot{Version: 1, Semester: "2025-09", FetchedAt: time.Now().UTC().Format(time.RFC3339), ClassCount: 1, Items: []EnrollmentItem{{"课程", "班级", "教师", 3}}}
	if err := WriteJSON(filepath.Join(dir, "enrollment_snapshot.json"), snapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	service := NewEnrollmentService(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, _, ok := service.Responses(); ok {
		t.Fatal("snapshot from another semester was loaded")
	}
}
