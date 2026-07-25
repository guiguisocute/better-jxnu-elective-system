package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// errD1NotConfigured is the shared sentinel for "no D1 credentials yet", so the
// warmer and the schema bootstrap can tell that apart from a real failure.
var errD1NotConfigured = errors.New("Cloudflare D1 凭据未配置")

// 操作日志：面板上每一次改动评价数据或站点开关的动作都写一行 admin_audit，并同时
// 打到 journald。两处都记是有意的——D1 那份能在面板里翻页、能看 before/after，
// journald 那份在 D1 挂掉或凭据失效时仍然留痕（/logs 页可见）。
//
// 面板只有一个共享管理密码，没有用户体系，所以 actor 记成 admin@<来源IP>；面板只
// 监听回环、走 SSH 隧道，这已经足够回答「什么时候、从哪条隧道、做了什么」。
// 任何密钥值一律不入库，只记「已更新 / 已清除」这种结论。

const auditPageSize = 30

// audit action slugs. Kept as constants so the filter dropdown and the writers
// can never drift apart.
const (
	auditDeleteReview  = "delete-review"
	auditRestoreReview = "restore-review"
	auditPurgeTrash    = "purge-trash"
	auditEditReview    = "edit-review"
	auditCreateReview  = "create-review"
	auditModerate      = "moderate-review"
	auditPurgeReviews  = "purge-reviews"
	auditResolveReport = "resolve-report"
	auditModeration    = "review-moderation"
	auditCaptcha       = "captcha-config"
	auditD1Connection  = "d1-connection"
	auditDeployment    = "deployment-config"
)

var auditActionLabels = map[string]string{
	auditDeleteReview:  "删除评价",
	auditRestoreReview: "还原评价",
	auditPurgeTrash:    "清空回收站",
	auditEditReview:    "编辑评价",
	auditCreateReview:  "补录评价",
	auditModerate:      "审核评价",
	auditPurgeReviews:  "批量清理",
	auditResolveReport: "处理举报",
	auditModeration:    "审核模式开关",
	auditCaptcha:       "人机验证配置",
	auditD1Connection:  "D1 连接变更",
	auditDeployment:    "部署配置变更",
}

func auditActionLabel(action string) string {
	if label, ok := auditActionLabels[action]; ok {
		return label
	}
	return action
}

// auditEntry is one row to be written. before/after are optional JSON blobs.
type auditEntry struct {
	Action string
	Target string
	Detail string
	Before any
	After  any
}

// actorOf identifies the operator behind a request. There is one shared admin
// password, so the source address is the only distinguishing signal.
func actorOf(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if host == "" {
		return "admin"
	}
	return "admin@" + host
}

// audit records one administrative action. It is best-effort by design: the
// action it describes has already happened, so a logging failure must never be
// reported as the action failing. Failures are surfaced in journald instead.
func (a *AdminServer) audit(ctx context.Context, r *http.Request, entry auditEntry) {
	actor := actorOf(r)
	a.logger.Info("面板操作",
		"action", entry.Action, "actor", actor, "target", entry.Target, "detail", entry.Detail)

	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		return
	}
	// The caller's context may already be near its deadline (or cancelled if the
	// operator navigated away), so the log entry gets its own budget — a full
	// D1RequestTimeout, because it has to survive a cold start too. This runs
	// after the response is on its way out, so a slow write costs nobody.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), D1RequestTimeout)
	defer cancel()
	if err := a.EnsureReviewOpsTables(writeCtx); err != nil {
		a.logger.Warn("写操作日志前建表失败", "error", err)
		return
	}
	_, _, err := cloudflare.D1Query(writeCtx,
		`INSERT INTO admin_audit (actor, action, target, detail, before, after) VALUES (?,?,?,?,?,?)`,
		[]any{actor, entry.Action, entry.Target, entry.Detail, auditJSON(entry.Before), auditJSON(entry.After)})
	if err != nil {
		a.logger.Warn("写操作日志失败", "action", entry.Action, "error", err)
	}
}

// auditJSON marshals a snapshot for storage, returning nil (SQL NULL) for
// absent values so empty columns stay empty rather than holding "null".
func auditJSON(value any) any {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return string(raw)
}

func (a *AdminServer) auditPage(w http.ResponseWriter, r *http.Request, session adminSession) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.reviewD1Unavailable(w, session)
		return
	}

	action := r.URL.Query().Get("action")
	if _, ok := auditActionLabels[action]; !ok {
		action = "all"
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}

	ctx, cancel := context.WithTimeout(r.Context(), D1RequestTimeout)
	defer cancel()
	if err := a.EnsureReviewOpsTables(ctx); err != nil {
		a.render(w, "操作日志", reviewsSubnav("audit")+a.reviewD1SetupForm(session, err.Error()), &session)
		return
	}

	sql := `SELECT * FROM admin_audit`
	params := []any{}
	if action != "all" {
		sql += ` WHERE action = ?`
		params = append(params, action)
	}
	sql += ` ORDER BY id DESC LIMIT ? OFFSET ?`
	params = append(params, auditPageSize, (page-1)*auditPageSize)

	rows, _, err := cloudflare.D1Query(ctx, sql, params)
	if err != nil {
		a.render(w, "操作日志", reviewsSubnav("audit")+a.reviewD1SetupForm(session, err.Error()), &session)
		return
	}

	var b strings.Builder
	b.WriteString(`<section class="hero"><div><p class="eyebrow">评价管理</p><h1>操作日志</h1><p>面板上每一次改动评价数据或站点开关的动作都在这里留痕，可按类型筛选。同一份记录也写入 systemd 日志，可在<a href="/logs">日志</a>页查看。</p></div></section>`)
	b.WriteString(reviewsSubnav("audit"))

	b.WriteString(`<section class="card"><h2>筛选</h2><form method="get" action="/reviews/audit" class="searchbar"><select name="action"><option value="all">全部动作</option>`)
	for _, key := range auditActionOrder {
		selected := ""
		if key == action {
			selected = " selected"
		}
		b.WriteString(`<option value="` + key + `"` + selected + `>` + auditActionLabels[key] + `</option>`)
	}
	b.WriteString(`</select><button class="button" type="submit">筛选</button></form></section>`)

	b.WriteString(`<section class="card"><h2>记录</h2>`)
	if len(rows) == 0 {
		b.WriteString(`<p class="hint">这个范围内还没有记录。日志从本次版本上线后开始累计，之前的操作没有留痕。</p>`)
	}
	for _, row := range rows {
		b.WriteString(renderAuditRow(row))
	}
	b.WriteString(`<div class="pager">`)
	if page > 1 {
		b.WriteString(`<a class="button" href="` + auditListURL(action, page-1) + `">上一页</a>`)
	}
	if len(rows) == auditPageSize {
		b.WriteString(`<a class="button" href="` + auditListURL(action, page+1) + `">下一页</a>`)
	}
	b.WriteString(`</div></section>`)

	a.render(w, "操作日志", b.String(), &session)
}

// auditActionOrder fixes the dropdown order (map iteration is random).
var auditActionOrder = []string{
	auditDeleteReview, auditRestoreReview, auditPurgeTrash, auditEditReview, auditCreateReview,
	auditModerate, auditPurgeReviews, auditResolveReport, auditModeration, auditCaptcha, auditD1Connection, auditDeployment,
}

func renderAuditRow(row map[string]any) string {
	var b strings.Builder
	b.WriteString(`<div class="report-item"><p class="rev-title">` +
		template.HTMLEscapeString(auditActionLabel(reviewText(row, "action"))))
	if target := strings.TrimSpace(reviewText(row, "target")); target != "" {
		b.WriteString(` <code>` + template.HTMLEscapeString(target) + `</code>`)
	}
	b.WriteString(`</p>`)
	b.WriteString(`<p class="hint">` + template.HTMLEscapeString(reviewText(row, "at")) +
		` UTC · ` + template.HTMLEscapeString(reviewText(row, "actor")) +
		` · #` + strconv.Itoa(reviewInt(row, "id")) + `</p>`)
	if detail := strings.TrimSpace(reviewText(row, "detail")); detail != "" {
		b.WriteString(`<p>` + template.HTMLEscapeString(detail) + `</p>`)
	}
	for _, item := range [][2]string{{"before", "变更前"}, {"after", "变更后"}} {
		raw := strings.TrimSpace(reviewText(row, item[0]))
		if raw == "" {
			continue
		}
		b.WriteString(`<details><summary class="hint">` + item[1] + `</summary><pre class="log-view">` +
			template.HTMLEscapeString(prettyJSON(raw)) + `</pre></details>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

// prettyJSON re-indents a stored snapshot for display, falling back to the raw
// text when it is not valid JSON.
func prettyJSON(raw string) string {
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return raw
	}
	out, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return raw
	}
	return string(out)
}

func auditListURL(action string, page int) string {
	return fmt.Sprintf("/reviews/audit?action=%s&page=%d", action, page)
}

// reviewsSubnav renders the shared 评价管理 tab strip. current is one of
// list / trash / audit.
func reviewsSubnav(current string) string {
	items := []struct{ Key, Href, Label string }{
		{"list", "/reviews", "评价列表"},
		{"trash", "/reviews/trash", "回收站"},
		{"audit", "/reviews/audit", "操作日志"},
	}
	var b strings.Builder
	b.WriteString(`<section class="card"><div class="action-row">`)
	for _, item := range items {
		class := "button"
		if item.Key == current {
			class = "button primary"
		}
		b.WriteString(`<a class="` + class + `" href="` + item.Href + `">` + item.Label + `</a>`)
	}
	b.WriteString(`</div></section>`)
	return b.String()
}
