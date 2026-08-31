package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestReadLimitedRejectsTruncatedBody(t *testing.T) {
	body := strings.NewReader(strings.Repeat("x", 100))
	if _, err := readLimited(body, 50); err == nil {
		t.Fatal("readLimited 在超过上限时必须报错，不能返回截断内容")
	}
	if raw, err := readLimited(strings.NewReader("12345"), 5); err != nil || string(raw) != "12345" {
		t.Fatalf("正好等于上限应当成功：raw=%q err=%v", raw, err)
	}
}

func TestTruncateKeepsRuneBoundary(t *testing.T) {
	// "开课安排" 每个字 3 字节；在 max=5 处按字节切会劈开第二个字。
	got := truncate("开课安排", 5)
	if !isValidUTF8(got) {
		t.Fatalf("truncate 产生了非法 UTF-8：%q", got)
	}
	if got != "开…" {
		t.Fatalf("truncate = %q, want %q", got, "开…")
	}
	if got := truncate("abc", 10); got != "abc" {
		t.Fatalf("未超长时不应改动：%q", got)
	}
}

func isValidUTF8(value string) bool {
	for _, r := range value {
		if r == '�' {
			return false
		}
	}
	return true
}

func TestPublicEnrollmentPayloadHidesUpstreamError(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenConfigStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	service := NewEnrollmentService(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	detail := "打开 Public_Kkap: dial tcp 203.0.113.7:443: connect: connection refused"
	service.finishAttempt(nil, &stubError{detail}, time.Now(), 30)

	full, _, _ := service.Responses()
	var payload map[string]any
	if err := json.Unmarshal(full.raw, &payload); err != nil {
		t.Fatal(err)
	}
	message, _ := payload["error"].(string)
	if strings.Contains(message, "203.0.113.7") || strings.Contains(message, "Public_Kkap") {
		t.Fatalf("公开响应泄漏了上游细节：%q", message)
	}
	if message != publicEnrollmentErrorMessage {
		t.Fatalf("公开错误 = %q, want %q", message, publicEnrollmentErrorMessage)
	}
	// 面板走 Status()，必须仍然拿得到完整原因。
	if got := service.Status().Error; got == nil || *got != detail {
		t.Fatalf("面板侧应保留原始错误，got=%v", got)
	}
}

type stubError struct{ message string }

func (e *stubError) Error() string { return e.message }

func TestCrawlCapacityAbortsAfterConsecutiveFailures(t *testing.T) {
	courseIDs := make([]string, 500)
	for i := range courseIDs {
		courseIDs[i] = "C" + strconv.Itoa(i)
	}
	attempts := 0
	fetch := func(context.Context, string) (CapacityCourse, error) {
		attempts++
		return CapacityCourse{}, &stubError{"访问受限：当前选课阶段为【补退选】"}
	}
	_, err := crawlCapacityCourses(context.Background(), &CapacitySnapshot{}, courseIDs, map[string]string{}, fetch, 0, nil)
	if err == nil {
		t.Fatal("会话失效时应当整轮失败，而不是返回一份几乎空的容量快照")
	}
	if attempts != capacityAbortAfterConsecutiveFailures {
		t.Fatalf("应在连续 %d 次失败后中止，实际尝试 %d 次", capacityAbortAfterConsecutiveFailures, attempts)
	}
	if !strings.Contains(err.Error(), "当前选课阶段") {
		t.Fatalf("错误里应保留首个失败原因，got=%v", err)
	}
}

func TestCrawlCapacityResetsFailureStreakOnSuccess(t *testing.T) {
	courseIDs := []string{"a", "b", "c", "d"}
	fetch := func(_ context.Context, id string) (CapacityCourse, error) {
		if id == "b" {
			return CapacityCourse{}, &stubError{"偶发超时"}
		}
		return CapacityCourse{CourseID: id, Classes: []CapacityClass{{ClassID: "1"}}}, nil
	}
	snapshot, err := crawlCapacityCourses(context.Background(), &CapacitySnapshot{}, courseIDs, map[string]string{}, fetch, 0, nil)
	if err != nil {
		t.Fatalf("零星失败不该中止整轮：%v", err)
	}
	if snapshot.Summary.Visible != 3 || snapshot.Summary.Total != 3 {
		t.Fatalf("visible=%d total=%d，want 3/3", snapshot.Summary.Visible, snapshot.Summary.Total)
	}
}

func TestCrawlCapacityStopsOnCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	attempts := 0
	fetch := func(context.Context, string) (CapacityCourse, error) {
		attempts++
		return CapacityCourse{}, nil
	}
	// delay=0 时循环里没有 select，取消必须靠显式的 ctx.Err() 检查。
	if _, err := crawlCapacityCourses(ctx, &CapacitySnapshot{}, []string{"a", "b"}, map[string]string{}, fetch, 0, nil); err == nil {
		t.Fatal("ctx 已取消时应立即返回错误")
	}
	if attempts != 0 {
		t.Fatalf("取消后不应再发请求，实际 %d 次", attempts)
	}
}
func TestEnrollmentRefreshSecondsBounds(t *testing.T) {
	for _, tc := range []struct {
		seconds int
		ok      bool
	}{{4, false}, {5, true}, {10, true}, {3600, true}, {3601, false}} {
		cfg := DefaultRuntimeConfig()
		cfg.EnrollmentRefreshSeconds = tc.seconds
		err := cfg.Validate()
		if (err == nil) != tc.ok {
			t.Fatalf("EnrollmentRefreshSeconds=%d: err=%v, 期望通过=%v", tc.seconds, err, tc.ok)
		}
	}
}

func TestCappedReaderRejectsOversizedStream(t *testing.T) {
	_, err := ParsePublicScheduleFrom(&cappedReader{
		reader: strings.NewReader(strings.Repeat("<tr><td>x</td></tr>", 5000)),
		limit:  100,
	})
	if err == nil {
		t.Fatal("超过上限的流必须整体报错，不能按截断内容解析出行")
	}
	if !strings.Contains(err.Error(), "上限") {
		t.Fatalf("错误应说明是超限，got=%v", err)
	}
}

func TestParsePublicScheduleFromMatchesStringVariant(t *testing.T) {
	page := `<table><tr><td>1</td><td>计算机学院</td><td>数据结构</td><td>24计科1班</td>` +
		`<td>张三</td><td>A101</td><td>周一</td><td>第12节</td><td>60</td>` +
		`<td><a href="x.aspx?kch=C001&bjh=B01&xq=2026/9/1">详情</a></td></tr></table>`
	fromString, err := ParsePublicSchedule(page)
	if err != nil {
		t.Fatal(err)
	}
	fromStream, err := ParsePublicScheduleFrom(&cappedReader{reader: strings.NewReader(page), limit: 1 << 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(fromStream) != len(fromString) {
		t.Fatalf("流式与字符串版本行数不一致：%d vs %d", len(fromStream), len(fromString))
	}
	if fromStream[0] != fromString[0] {
		t.Fatalf("流式与字符串版本解析结果不一致：\n%#v\n%#v", fromStream[0], fromString[0])
	}
}
