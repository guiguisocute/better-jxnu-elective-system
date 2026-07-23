package app

import (
	"bytes"
	"context"
	"fmt"
	"html/template"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type adminLogSource struct {
	Key   string
	Label string
	Unit  string
}

var adminLogSources = []adminLogSource{
	{Key: "backend", Label: "常驻后端", Unit: "jxnu-backend.service"},
	{Key: "sync", Label: "自动构建任务", Unit: "jxnu-sync.service"},
	{Key: "timer", Label: "自动构建调度器", Unit: "jxnu-sync.timer"},
}

func (a *AdminServer) logs(w http.ResponseWriter, r *http.Request, session adminSession) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	source := logSource(r.URL.Query().Get("source"))
	lineCount := boundedLogLines(r.URL.Query().Get("lines"))
	sinceKey, sinceValue := logSince(r.URL.Query().Get("since"))
	output, readErr := readJournal(r.Context(), source.Unit, lineCount, sinceValue)
	status := `<span class="badge">读取成功</span>`
	if readErr != nil {
		status = `<span class="badge warn">读取失败</span>`
		output = readErr.Error() + "\n\n" + output
	}
	body := fmt.Sprintf(`<section class="hero"><div><p class="eyebrow">只读运维</p><h1>服务日志</h1><p>仅允许查看三个 JXNU systemd 单元，不接受任意命令或任意 unit 名。</p></div>%s</section>
<section class="card"><form method="get" action="/logs"><div class="grid three"><div class="field"><label>日志来源</label><select name="source">%s</select></div><div class="field"><label>时间范围</label><select name="since">%s</select></div><div class="field"><label>最多行数</label><select name="lines">%s</select></div></div><button class="button primary" type="submit">刷新日志</button></form></section>
<section class="card"><div class="log-head"><h2>%s · %s</h2><span class="hint">最多 %d 行</span></div><pre class="log-view">%s</pre></section>`, status, logSourceOptions(source.Key), logSinceOptions(sinceKey), logLineOptions(lineCount), template.HTMLEscapeString(source.Label), template.HTMLEscapeString(source.Unit), lineCount, template.HTMLEscapeString(output))
	a.render(w, "日志", body, &session)
}

func logSource(key string) adminLogSource {
	for _, source := range adminLogSources {
		if source.Key == key {
			return source
		}
	}
	return adminLogSources[0]
}

func boundedLogLines(raw string) int {
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 300
	}
	for _, allowed := range []int{100, 300, 1000, 3000} {
		if value == allowed {
			return value
		}
	}
	return 300
}

func logSince(key string) (string, string) {
	values := map[string]string{"1h": "1 hour ago", "6h": "6 hours ago", "24h": "24 hours ago", "7d": "7 days ago"}
	if value, ok := values[key]; ok {
		return key, value
	}
	return "6h", values["6h"]
}

func readJournal(parent context.Context, unit string, lines int, since string) (string, error) {
	if runtime.GOOS == "windows" {
		return "", fmt.Errorf("journalctl 仅在 VPS Linux 环境可用")
	}
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "journalctl", "--user", "-u", unit, "--since", since, "-n", strconv.Itoa(lines), "--no-pager", "--output=short-iso")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return stdout.String(), fmt.Errorf("读取日志超时")
	}
	if err != nil {
		return stdout.String(), fmt.Errorf("journalctl: %s", strings.TrimSpace(stderr.String()))
	}
	if stdout.Len() == 0 {
		return "（所选范围内没有日志）", nil
	}
	return stdout.String(), nil
}

func logSourceOptions(current string) string {
	var b strings.Builder
	for _, source := range adminLogSources {
		b.WriteString(`<option value="` + source.Key + `"`)
		if source.Key == current {
			b.WriteString(" selected")
		}
		b.WriteString(`>` + template.HTMLEscapeString(source.Label) + `</option>`)
	}
	return b.String()
}

func logSinceOptions(current string) string {
	items := []struct{ Key, Label string }{{"1h", "最近 1 小时"}, {"6h", "最近 6 小时"}, {"24h", "最近 24 小时"}, {"7d", "最近 7 天"}}
	var b strings.Builder
	for _, item := range items {
		b.WriteString(`<option value="` + item.Key + `"`)
		if item.Key == current {
			b.WriteString(" selected")
		}
		b.WriteString(`>` + item.Label + `</option>`)
	}
	return b.String()
}

func logLineOptions(current int) string {
	var b strings.Builder
	for _, value := range []int{100, 300, 1000, 3000} {
		b.WriteString(`<option value="` + strconv.Itoa(value) + `"`)
		if value == current {
			b.WriteString(" selected")
		}
		b.WriteString(`>` + strconv.Itoa(value) + ` 行</option>`)
	}
	return b.String()
}
