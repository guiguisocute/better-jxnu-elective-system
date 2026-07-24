package app

import (
	"context"
	"fmt"
	"html/template"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// reviewDimensions is the fixed set of rating dimensions carried by the D1
// `reviews` table. Order drives table columns and the edit form layout.
var reviewDimensions = []struct {
	Score   string // numeric column
	Comment string // matching *_c comment column
	Label   string
}{
	{"overall", "overall_c", "总体评分"},
	{"assess", "assess_c", "考核给分"},
	{"attendance", "attendance_c", "考勤频率"},
	{"difficulty", "difficulty_c", "课程强度"},
	{"teaching", "teaching_c", "教学质量"},
}

const reviewPageSize = 20

// parseReviewScore validates one dimension score coming from the form. Empty is
// allowed (returns nil so the SQL param becomes NULL); otherwise the value must
// be within 0.5–5 on a 0.5 step.
func parseReviewScore(raw string) (any, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return nil, fmt.Errorf("评分必须是数字")
	}
	if v < 0.5 || v > 5 || math.Mod(v*2, 1) != 0 {
		return nil, fmt.Errorf("评分须为 0.5–5 且以 0.5 为步进")
	}
	return v, nil
}

// reviewD1SetupForm renders the self-service credential card (same UX as the AI
// page's Cloudflare connection form). Shown when D1 is not configured yet, or as
// a recovery path when queries fail (expired token / missing D1 permission).
// The API token is shared with the Pages management token; leaving it blank
// keeps the currently stored one.
func (a *AdminServer) reviewD1SetupForm(session adminSession, notice string) string {
	cloudflare := a.cloudflareClient()
	noticeHTML := ""
	if notice != "" {
		noticeHTML = `<section class="card result error"><h2>连接 Cloudflare D1 失败</h2><p>` + template.HTMLEscapeString(notice) + `</p><p class="hint">常见原因：API Token 失效或缺少 Account / D1 / Edit 权限、Account ID 或库 ID 填错。请在下方修正后重新验证。</p></section>`
	}
	tokenLabel := "Cloudflare API Token"
	tokenHint := `<p class="hint">Token 需要 Account / D1 / Edit 权限（可与 Pages 管理共用同一个 Token，一并勾选两种权限）。Token 只写入 VPS 的 backend.env，不会显示在页面或日志中。</p>`
	tokenRequired := ` required`
	if cloudflare.apiToken != "" {
		tokenLabel += "（留空 = 沿用现有 Token）"
		tokenRequired = ""
	}
	accountValue := cloudflare.accountID
	dbValue := cloudflare.d1DatabaseID
	if dbValue == "" {
		dbValue = a.env.CFD1DatabaseID
	}
	return noticeHTML +
		`<section class="card"><h2>连接 Cloudflare D1</h2><p>评价数据存放在 Cloudflare D1 库 <code>jxnu-ratings</code>。在此填写凭据，验证通过后以 0600 权限写入 backend.env 并立即生效。</p>` +
		`<form method="post" action="/action/save-d1" class="stack">` + csrf(session) +
		`<div class="field"><label>Cloudflare Account ID</label><input name="cfAccountID" minlength="32" maxlength="32" autocomplete="off" value="` + template.HTMLEscapeString(accountValue) + `" required></div>` +
		`<div class="field"><label>` + tokenLabel + `</label><input type="password" name="cfAPIToken" maxlength="512" autocomplete="new-password"` + tokenRequired + `></div>` +
		tokenHint +
		`<div class="field"><label>D1 数据库 ID <code>CF_D1_DATABASE_ID</code></label><input name="cfD1DatabaseID" minlength="8" maxlength="64" value="` + template.HTMLEscapeString(dbValue) + `" required><p class="hint">Cloudflare Dashboard → D1 → jxnu-ratings 详情页可见；默认值即仓库 wrangler.toml 里的库 ID，一般无需修改。</p></div>` +
		`<button class="button primary" type="submit">验证并保存 D1 连接</button></form></section>`
}

// reviewD1Unavailable renders the setup card when the D1 binding is not yet
// configured, so the handlers never touch a nil client path.
func (a *AdminServer) reviewD1Unavailable(w http.ResponseWriter, session adminSession) {
	body := `<section class="hero"><div><p class="eyebrow">评价管理</p><h1>学生课程评价监管</h1></div></section>` +
		a.reviewD1SetupForm(session, "")
	a.render(w, "评价管理", body, &session)
}

func reviewScoreCell(row map[string]any, key string) string {
	value, ok := row[key]
	if !ok || value == nil {
		return "—"
	}
	switch v := value.(type) {
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case string:
		if strings.TrimSpace(v) == "" {
			return "—"
		}
		return template.HTMLEscapeString(v)
	default:
		return template.HTMLEscapeString(fmt.Sprint(v))
	}
}

func reviewText(row map[string]any, key string) string {
	if value, ok := row[key]; ok && value != nil {
		if s, ok := value.(string); ok {
			return s
		}
		return fmt.Sprint(value)
	}
	return ""
}

func reviewInt(row map[string]any, key string) int {
	if value, ok := row[key]; ok && value != nil {
		switch v := value.(type) {
		case float64:
			return int(v)
		case int:
			return v
		}
	}
	return 0
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// reviewStatusMeta maps a status value (whitelist) to its badge class + label.
var reviewStatusMeta = map[string]struct{ Class, Label string }{
	"approved": {"badge", "已公开"},
	"pending":  {"badge warn", "待审核"},
	"rejected": {"badge err", "已拒绝"},
}

// reviewFloat extracts a numeric dimension score; ok=false when absent/blank.
func reviewFloat(row map[string]any, key string) (float64, bool) {
	value, present := row[key]
	if !present || value == nil {
		return 0, false
	}
	switch v := value.(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

func (a *AdminServer) reviewsPage(w http.ResponseWriter, r *http.Request, session adminSession) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.reviewD1Unavailable(w, session)
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	field := r.URL.Query().Get("field")
	if field != "course" && field != "teacher" && field != "voter" {
		field = "course"
	}
	status := r.URL.Query().Get("status")
	if _, ok := reviewStatusMeta[status]; !ok {
		status = "all"
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	offset := (page - 1) * reviewPageSize

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	fieldColumn := map[string]string{"course": "r.course_id", "teacher": "r.teacher_id", "voter": "r.voter_id"}[field]
	sql := `SELECT r.*, (SELECT COUNT(*) FROM review_votes v WHERE v.review_id=r.id) AS helpful FROM reviews r`
	var params []any
	var where []string
	if q != "" {
		where = append(where, fieldColumn+" LIKE ?")
		params = append(params, "%"+q+"%")
	}
	if status != "all" {
		// status is whitelisted above; still bind as a parameter.
		where = append(where, "r.status = ?")
		params = append(params, status)
	}
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY r.updated_at DESC LIMIT ? OFFSET ?"
	params = append(params, reviewPageSize, offset)

	rows, _, err := cloudflare.D1Query(ctx, sql, params)
	if err != nil {
		// 查询失败（token 失效 / 缺 D1 权限 / 库 ID 错）→ 与未配置同款自助表单，现场修
		a.render(w, "评价管理",
			`<section class="hero"><div><p class="eyebrow">评价管理</p><h1>学生课程评价监管</h1></div></section>`+
				a.reviewD1SetupForm(session, err.Error()), &session)
		return
	}

	totalReviews, totalVotes, pendingCount := 0, 0, 0
	if stat, _, err := cloudflare.D1Query(ctx, `SELECT (SELECT COUNT(*) FROM reviews) AS reviews, (SELECT COUNT(*) FROM review_votes) AS votes, (SELECT COUNT(*) FROM reviews WHERE status='pending') AS pending`, nil); err == nil && len(stat) > 0 {
		totalReviews = reviewInt(stat[0], "reviews")
		totalVotes = reviewInt(stat[0], "votes")
		pendingCount = reviewInt(stat[0], "pending")
	}

	moderationOn := false
	if m, _, err := cloudflare.D1Query(ctx, `SELECT value FROM app_settings WHERE key='review_moderation'`, nil); err == nil && len(m) > 0 {
		moderationOn = reviewText(m[0], "value") == "on"
	}

	// 未处理举报数（通知感）
	openReports := 0
	if rc, _, err := cloudflare.D1Query(ctx, `SELECT COUNT(*) AS n FROM review_reports WHERE status='open'`, nil); err == nil && len(rc) > 0 {
		openReports = reviewInt(rc[0], "n")
	}

	// 未处理举报列表（仅在有 open 举报时查询）
	var reportRows []map[string]any
	if openReports > 0 {
		if rr, _, err := cloudflare.D1Query(ctx, `SELECT rp.id AS report_id, rp.reason AS report_reason, rp.created_at AS reported_at, rp.voter_id AS reporter, r.* FROM review_reports rp LEFT JOIN reviews r ON r.id = rp.review_id WHERE rp.status='open' ORDER BY rp.created_at DESC LIMIT 20`, nil); err == nil {
			reportRows = rr
		}
	}

	courseName, teacherName := a.reviewNames()

	var b strings.Builder
	b.WriteString(`<section class="hero"><div><p class="eyebrow">评价管理</p><h1>学生课程评价监管</h1><p>直连 Cloudflare D1 库 jxnu-ratings，可查看、编辑、删除、审核与批量清理评价。</p></div><a class="button primary" href="/reviews/edit">手工补录评价</a></section>`)

	// stats: 5 cards（第 5 张「未处理举报」有通知感）
	reportCard := fmt.Sprintf(`<section class="card"><h2>未处理举报</h2><p class="big">%d</p></section>`, openReports)
	if openReports > 0 {
		reportCard = fmt.Sprintf(`<section class="card report open"><h2>未处理举报</h2><p class="big" style="color:#c0363f">%d</p><p class="hint">有待处理的举报</p></section>`, openReports)
	}
	b.WriteString(fmt.Sprintf(`<div class="grid five"><section class="card"><h2>总评价数</h2><p class="big">%d</p></section><section class="card"><h2>待审核</h2><p class="big">%d</p></section><section class="card"><h2>总投票数</h2><p class="big">%d</p></section><section class="card"><h2>当前页</h2><p class="big">第 %d 页</p><p class="hint">每页 %d 条</p></section>%s</div>`, totalReviews, pendingCount, totalVotes, page, reviewPageSize, reportCard))

	// moderation switch card
	moderationBadge := `<span class="hint">关闭：评价即发即显</span>`
	nextEnable := "on"
	buttonLabel := "开启审核模式"
	if moderationOn {
		moderationBadge = `<span class="badge warn">开启中：新评价需人工审核</span>`
		nextEnable = "off"
		buttonLabel = "关闭审核模式"
	}
	b.WriteString(`<section class="card"><h2>审核模式</h2><p>` + moderationBadge + `</p><p class="hint">开启后，新提交的评价默认进入待审核，需在此页面手动通过后才对外可见。</p><form method="post" action="/action/review-moderation">` + csrf(session) + `<input type="hidden" name="enable" value="` + nextEnable + `"><button class="button" type="submit">` + buttonLabel + `</button></form></section>`)

	// 人机验证（Turnstile）开关：D1 app_settings（与审核模式同源），改完即生效不需部署
	tsSiteKey, tsSecretSet := "", false
	if ts, _, err := cloudflare.D1Query(ctx, `SELECT key, value FROM app_settings WHERE key IN ('turnstile_site_key','turnstile_secret')`, nil); err == nil {
		for _, row := range ts {
			switch reviewText(row, "key") {
			case "turnstile_site_key":
				tsSiteKey = strings.TrimSpace(reviewText(row, "value"))
			case "turnstile_secret":
				if strings.TrimSpace(reviewText(row, "value")) != "" {
					tsSecretSet = true
				}
			}
		}
	}
	b.WriteString(a.turnstileCard(session, tsSiteKey, tsSecretSet))

	// 举报处理 card
	b.WriteString(`<section class="card report"><h2>举报处理</h2>`)
	if len(reportRows) == 0 {
		b.WriteString(`<p class="hint">暂无未处理举报。</p>`)
	} else {
		for _, rp := range reportRows {
			b.WriteString(renderReportItem(rp, session, courseName, teacherName))
		}
	}
	b.WriteString(`</section>`)

	// search form (with status dropdown)
	sel := func(name, cur, v, label string) string {
		s := ""
		if cur == v {
			s = " selected"
		}
		_ = name
		return `<option value="` + v + `"` + s + `>` + label + `</option>`
	}
	b.WriteString(`<section class="card"><h2>搜索</h2><form method="get" action="/reviews" class="searchbar"><select name="field">` +
		sel("field", field, "course", "课程号") + sel("field", field, "teacher", "教师号") + sel("field", field, "voter", "voter") +
		`</select><select name="status">` +
		sel("status", status, "all", "全部") + sel("status", status, "pending", "待审核") + sel("status", status, "approved", "已公开") + sel("status", status, "rejected", "已拒绝") +
		`</select><input name="q" value="` + template.HTMLEscapeString(q) + `" placeholder="输入搜索词" maxlength="64"><button class="button" type="submit">搜索</button></form></section>`)

	// review cards
	b.WriteString(`<section class="card"><h2>评价列表</h2>`)
	if len(rows) == 0 {
		b.WriteString(`<p class="hint">没有匹配的评价。</p>`)
	}
	for _, row := range rows {
		b.WriteString(renderReviewCard(row, session, courseName, teacherName))
	}

	// pager
	b.WriteString(`<div class="pager">`)
	if page > 1 {
		b.WriteString(`<a class="button" href="` + reviewListURL(q, field, status, page-1) + `">上一页</a>`)
	}
	if len(rows) == reviewPageSize {
		b.WriteString(`<a class="button" href="` + reviewListURL(q, field, status, page+1) + `">下一页</a>`)
	}
	b.WriteString(`</div></section>`)

	// batch purge
	b.WriteString(`<section class="card"><h2>批量清理（精确匹配）</h2><p class="hint">按精确的 voter 或教师号删除全部评价，删除前会统计条数并在结果中反馈。此操作不可恢复。</p><div class="grid three">`)
	b.WriteString(`<form method="post" action="/action/purge-reviews" class="stack">` + csrf(session) + `<input type="hidden" name="purgeField" value="voter"><div class="field"><label>按 voter 精确删除</label><input name="purgeValue" maxlength="64" required></div><button class="button" type="submit">删除该 voter 的评价</button></form>`)
	b.WriteString(`<form method="post" action="/action/purge-reviews" class="stack">` + csrf(session) + `<input type="hidden" name="purgeField" value="teacher"><div class="field"><label>按教师号精确删除</label><input name="purgeValue" maxlength="64" required></div><button class="button" type="submit">删除该教师的评价</button></form>`)
	b.WriteString(`</div></section>`)

	a.render(w, "评价管理", b.String(), &session)
}

// renderReviewCard renders one review as a card. All dynamic values are HTML
// escaped; colors are static constants injected inline.
func renderReviewCard(row map[string]any, session adminSession, courseName, teacherName func(id string) string) string {
	var b strings.Builder
	id := reviewInt(row, "id")
	courseID := reviewText(row, "course_id")
	teacherID := reviewText(row, "teacher_id")
	status := reviewText(row, "status")
	meta, ok := reviewStatusMeta[status]
	if !ok {
		meta = reviewStatusMeta["approved"]
	}

	cName := courseName(courseID)
	if cName == "" {
		cName = "未知课程"
	}
	tName := teacherName(teacherID)
	if tName == "" {
		tName = "未知教师"
	}

	b.WriteString(`<div class="rev">`)
	// head row
	b.WriteString(`<div class="rev-head"><div class="rev-title">` +
		template.HTMLEscapeString(cName) + ` <code>` + template.HTMLEscapeString(courseID) + `</code> · ` +
		template.HTMLEscapeString(tName) + ` <code>` + template.HTMLEscapeString(teacherID) + `</code></div>` +
		`<span class="` + meta.Class + `">` + meta.Label + `</span></div>`)

	// hint row
	nickname := strings.TrimSpace(reviewText(row, "nickname"))
	if nickname == "" {
		nickname = "匿名同学"
	}
	voter := reviewText(row, "voter_id")
	b.WriteString(`<p class="hint rev-meta">` + template.HTMLEscapeString(nickname) +
		` · <span title="` + template.HTMLEscapeString(voter) + `">` + template.HTMLEscapeString(truncateRunes(voter, 8)) + `</span>` +
		` · 有用 ` + strconv.Itoa(reviewInt(row, "helpful")) +
		` · ` + template.HTMLEscapeString(reviewText(row, "updated_at")) +
		` · #` + strconv.Itoa(id) + `</p>`)

	// dimension chips
	b.WriteString(`<div class="rev-chips">`)
	for _, d := range reviewDimMetas {
		score, has := reviewFloat(row, d.Score)
		if !has {
			continue
		}
		val := strconv.FormatFloat(score, 'f', -1, 64)
		b.WriteString(`<span class="rev-chip" title="` + template.HTMLEscapeString(d.starTierLabel(score)) +
			`" style="background:` + d.Color + `1A;color:` + d.Color + `">` +
			template.HTMLEscapeString(d.Chip) + ` ★` + val + `</span>`)
	}
	b.WriteString(`</div>`)

	// comments
	for _, d := range reviewDimMetas {
		full := strings.TrimSpace(reviewText(row, d.Comment))
		if full == "" {
			continue
		}
		b.WriteString(`<div class="rev-quote" style="border-color:` + d.Color + `"><span class="rev-quote-label" style="color:` + d.Color + `">` +
			template.HTMLEscapeString(d.Chip) + `</span>` + template.HTMLEscapeString(full) + `</div>`)
	}

	// actions
	b.WriteString(`<div class="rev-actions">`)
	b.WriteString(`<a class="button" href="/reviews/edit?id=` + strconv.Itoa(id) + `">编辑</a>`)
	if status == "pending" {
		b.WriteString(`<form method="post" action="/action/moderate-review">` + csrf(session) + `<input type="hidden" name="id" value="` + strconv.Itoa(id) + `"><input type="hidden" name="decision" value="approved"><button class="button" type="submit">✔ 通过</button></form>`)
		b.WriteString(`<form method="post" action="/action/moderate-review">` + csrf(session) + `<input type="hidden" name="id" value="` + strconv.Itoa(id) + `"><input type="hidden" name="decision" value="rejected"><button class="button" type="submit">✘ 拒绝</button></form>`)
	}
	b.WriteString(`<form method="post" action="/action/delete-review">` + csrf(session) + `<input type="hidden" name="id" value="` + strconv.Itoa(id) + `"><button class="link" type="submit" style="color:#c0363f">删除</button></form>`)
	b.WriteString(`</div>`)

	b.WriteString(`</div>`)
	return b.String()
}

// renderReportItem renders one open report: metadata + the reported review card
// (or a deleted-notice) + resolve actions. `row` carries aliased report columns
// (report_id / report_reason / reported_at / reporter) plus the joined review's
// r.* columns (all NULL when the review was already deleted).
func renderReportItem(row map[string]any, session adminSession, courseName, teacherName func(id string) string) string {
	var b strings.Builder
	reportID := reviewInt(row, "report_id")
	reporter := reviewText(row, "reporter")
	reason := strings.TrimSpace(reviewText(row, "report_reason"))
	if reason == "" {
		reason = "未填写理由"
	}
	reviewDeleted := row["id"] == nil

	b.WriteString(`<div class="report-item">`)
	b.WriteString(`<p class="hint">举报时间 ` + template.HTMLEscapeString(reviewText(row, "reported_at")) +
		` · 举报人 <span title="` + template.HTMLEscapeString(reporter) + `">` + template.HTMLEscapeString(truncateRunes(reporter, 8)) + `</span>` +
		` · 举报理由：` + template.HTMLEscapeString(reason) + `</p>`)

	if reviewDeleted {
		b.WriteString(`<p class="hint">原评价已删除。</p>`)
	} else {
		b.WriteString(renderReviewCard(row, session, courseName, teacherName))
	}

	b.WriteString(`<div class="rev-actions">`)
	b.WriteString(`<form method="post" action="/action/resolve-report">` + csrf(session) + `<input type="hidden" name="reportId" value="` + strconv.Itoa(reportID) + `"><button class="button" type="submit">标记已处理</button></form>`)
	if !reviewDeleted {
		b.WriteString(`<form method="post" action="/action/resolve-report">` + csrf(session) + `<input type="hidden" name="reportId" value="` + strconv.Itoa(reportID) + `"><input type="hidden" name="deleteReview" value="1"><button class="link" type="submit" style="color:#c0363f">删除该评价并处理</button></form>`)
	}
	b.WriteString(`</div></div>`)
	return b.String()
}

func reviewListURL(q, field, status string, page int) string {
	v := fmt.Sprintf("/reviews?field=%s&status=%s&page=%d", field, status, page)
	if q != "" {
		v += "&q=" + template.URLQueryEscaper(q)
	}
	return v
}

// toggleReviewModeration flips the review_moderation app-setting between on/off.
func (a *AdminServer) toggleReviewModeration(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "操作失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}
	enable := map[string]string{"on": "on", "off": "off"}[r.Form.Get("enable")]
	if enable == "" {
		a.result(w, "操作失败", "开关值不合法", false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, err := cloudflare.D1Query(ctx, `INSERT INTO app_settings (key,value) VALUES ('review_moderation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, []any{enable}); err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}
	if enable == "on" {
		a.result(w, "审核模式已开启", "新提交的评价将进入待审核，需人工通过后才对外可见。", true, &session)
		return
	}
	a.result(w, "审核模式已关闭", "评价将即发即显。", true, &session)
}

// moderateReview approves or rejects a single pending review.
func (a *AdminServer) moderateReview(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "操作失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}
	id, err := strconv.Atoi(strings.TrimSpace(r.Form.Get("id")))
	if err != nil {
		a.result(w, "操作失败", "评价 id 不合法", false, &session)
		return
	}
	decision, err := normalizeReviewDecision(r.Form.Get("decision"))
	if err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, err := cloudflare.D1Query(ctx, `UPDATE reviews SET status=?, updated_at=datetime('now') WHERE id=?`, []any{decision, id}); err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}
	verb := map[string]string{"approved": "已通过", "rejected": "已拒绝"}[decision]
	a.result(w, "审核完成", fmt.Sprintf("%s评价 #%d。", verb, id), true, &session)
}

// normalizeReviewDecision whitelists the moderation decision. Returns an error
// for anything outside {approved, rejected} so no SQL is issued on bad input.
func normalizeReviewDecision(raw string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "approved":
		return "approved", nil
	case "rejected":
		return "rejected", nil
	default:
		return "", fmt.Errorf("审核结论必须是通过或拒绝")
	}
}

func (a *AdminServer) reviewEditPage(w http.ResponseWriter, r *http.Request, session adminSession) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.reviewD1Unavailable(w, session)
		return
	}

	idStr := strings.TrimSpace(r.URL.Query().Get("id"))
	var row map[string]any
	editing := false
	if idStr != "" {
		id, err := strconv.Atoi(idStr)
		if err != nil {
			a.result(w, "参数错误", "评价 id 不合法", false, &session)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		rows, _, err := cloudflare.D1Query(ctx, `SELECT * FROM reviews WHERE id=?`, []any{id})
		if err != nil {
			a.result(w, "读取失败", err.Error(), false, &session)
			return
		}
		if len(rows) == 0 {
			a.result(w, "未找到", "该评价不存在或已被删除", false, &session)
			return
		}
		row = rows[0]
		editing = true
	}

	get := func(key string) string {
		if row == nil {
			return ""
		}
		return reviewText(row, key)
	}

	var b strings.Builder
	heading := "手工补录评价"
	if editing {
		heading = "编辑评价 #" + idStr
	}
	b.WriteString(`<section class="hero"><div><p class="eyebrow">评价管理</p><h1>` + template.HTMLEscapeString(heading) + `</h1></div><a class="button" href="/reviews">返回列表</a></section>`)
	b.WriteString(`<form method="post" action="/action/save-review" class="stack">` + csrf(session))
	if editing {
		b.WriteString(`<input type="hidden" name="id" value="` + template.HTMLEscapeString(idStr) + `">`)
	}

	b.WriteString(`<section class="card"><h2>关联信息</h2>`)
	if editing {
		b.WriteString(`<input type="hidden" name="course_id" value="` + template.HTMLEscapeString(get("course_id")) + `"><input type="hidden" name="teacher_id" value="` + template.HTMLEscapeString(get("teacher_id")) + `"><input type="hidden" name="voter_id" value="` + template.HTMLEscapeString(get("voter_id")) + `">`)
		b.WriteString(`<dl class="facts"><div><dt>课程号</dt><dd>` + template.HTMLEscapeString(get("course_id")) + `</dd></div><div><dt>教师号</dt><dd>` + template.HTMLEscapeString(get("teacher_id")) + `</dd></div><div><dt>voter</dt><dd>` + template.HTMLEscapeString(get("voter_id")) + `</dd></div></dl>`)
	} else {
		b.WriteString(`<div class="field"><label>课程号 course_id</label><input name="course_id" maxlength="64" required></div>`)
		b.WriteString(`<div class="field"><label>教师号 teacher_id</label><input name="teacher_id" maxlength="64" required></div>`)
		b.WriteString(`<div class="field"><label>voter_id</label><input name="voter_id" maxlength="64" value="admin-manual" required></div>`)
	}
	b.WriteString(`<div class="field"><label>昵称 nickname</label><input name="nickname" maxlength="64" value="` + template.HTMLEscapeString(get("nickname")) + `"></div>`)
	b.WriteString(`<div class="field"><label>头像 avatar</label><input name="avatar" maxlength="256" value="` + template.HTMLEscapeString(get("avatar")) + `"></div></section>`)

	b.WriteString(`<section class="card"><h2>各维度评分与评语</h2><p class="hint">评分可留空；至少填写一个维度。评语不超过 500 字。</p>`)
	for _, d := range reviewDimensions {
		b.WriteString(`<div class="field"><label>` + d.Label + ` 评分</label>` + reviewScoreSelect(d.Score, get(d.Score)) + `</div>`)
		b.WriteString(`<div class="field"><label>` + d.Label + ` 评语</label><textarea name="` + d.Comment + `" rows="2" maxlength="500">` + template.HTMLEscapeString(get(d.Comment)) + `</textarea></div>`)
	}
	b.WriteString(`</section>`)
	b.WriteString(`<div class="actions"><button class="button primary" type="submit">保存评价</button></div></form>`)

	a.render(w, "编辑评价", b.String(), &session)
}

func reviewScoreSelect(name, current string) string {
	// normalize current numeric like "4" / "4.0" to canonical form
	cur := strings.TrimSpace(current)
	if v, err := strconv.ParseFloat(cur, 64); err == nil {
		cur = strconv.FormatFloat(v, 'f', -1, 64)
	}
	var b strings.Builder
	b.WriteString(`<select name="` + name + `">`)
	b.WriteString(`<option value=""` + selectedAttr(cur == "") + `>—</option>`)
	for i := 1; i <= 10; i++ {
		val := strconv.FormatFloat(float64(i)/2, 'f', -1, 64)
		b.WriteString(`<option value="` + val + `"` + selectedAttr(cur == val) + `>` + val + `</option>`)
	}
	b.WriteString(`</select>`)
	return b.String()
}

func selectedAttr(ok bool) string {
	if ok {
		return " selected"
	}
	return ""
}

func (a *AdminServer) saveReview(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "保存失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}

	courseID := strings.TrimSpace(r.Form.Get("course_id"))
	teacherID := strings.TrimSpace(r.Form.Get("teacher_id"))
	voterID := strings.TrimSpace(r.Form.Get("voter_id"))
	for label, v := range map[string]string{"课程号": courseID, "教师号": teacherID, "voter_id": voterID} {
		if v == "" || len(v) > 64 {
			a.result(w, "保存失败", label+"不能为空且不超过 64 字符", false, &session)
			return
		}
	}

	nickname := strings.TrimSpace(r.Form.Get("nickname"))
	avatar := strings.TrimSpace(r.Form.Get("avatar"))
	if len(nickname) > 64 || len(avatar) > 256 {
		a.result(w, "保存失败", "昵称或头像超长", false, &session)
		return
	}

	scores := map[string]any{}
	comments := map[string]string{}
	hasScore := false
	for _, d := range reviewDimensions {
		score, err := parseReviewScore(r.Form.Get(d.Score))
		if err != nil {
			a.result(w, "保存失败", d.Label+"："+err.Error(), false, &session)
			return
		}
		if score != nil {
			hasScore = true
		}
		scores[d.Score] = score
		c := strings.TrimSpace(r.Form.Get(d.Comment))
		if len([]rune(c)) > 500 {
			a.result(w, "保存失败", d.Label+"评语不能超过 500 字", false, &session)
			return
		}
		comments[d.Comment] = c
	}
	if !hasScore {
		a.result(w, "保存失败", "至少填写一个维度的评分", false, &session)
		return
	}

	commentParam := func(key string) any {
		if comments[key] == "" {
			return nil
		}
		return comments[key]
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	idStr := strings.TrimSpace(r.Form.Get("id"))
	if idStr != "" {
		id, err := strconv.Atoi(idStr)
		if err != nil {
			a.result(w, "保存失败", "评价 id 不合法", false, &session)
			return
		}
		sql := `UPDATE reviews SET nickname=?, avatar=?, overall=?, assess=?, attendance=?, difficulty=?, teaching=?, overall_c=?, assess_c=?, attendance_c=?, difficulty_c=?, teaching_c=?, updated_at=datetime('now') WHERE id=?`
		params := []any{nickname, avatar,
			scores["overall"], scores["assess"], scores["attendance"], scores["difficulty"], scores["teaching"],
			commentParam("overall_c"), commentParam("assess_c"), commentParam("attendance_c"), commentParam("difficulty_c"), commentParam("teaching_c"),
			id}
		if _, _, err := cloudflare.D1Query(ctx, sql, params); err != nil {
			a.result(w, "保存失败", err.Error(), false, &session)
			return
		}
		a.result(w, "评价已更新", fmt.Sprintf("已更新评价 #%d。", id), true, &session)
		return
	}

	sql := `INSERT INTO reviews (course_id, teacher_id, voter_id, nickname, avatar, overall, assess, attendance, difficulty, teaching, overall_c, assess_c, attendance_c, difficulty_c, teaching_c, created_at, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
ON CONFLICT(course_id,teacher_id,voter_id) DO UPDATE SET nickname=excluded.nickname, avatar=excluded.avatar, overall=excluded.overall, assess=excluded.assess, attendance=excluded.attendance, difficulty=excluded.difficulty, teaching=excluded.teaching, overall_c=excluded.overall_c, assess_c=excluded.assess_c, attendance_c=excluded.attendance_c, difficulty_c=excluded.difficulty_c, teaching_c=excluded.teaching_c, updated_at=datetime('now')`
	params := []any{courseID, teacherID, voterID, nickname, avatar,
		scores["overall"], scores["assess"], scores["attendance"], scores["difficulty"], scores["teaching"],
		commentParam("overall_c"), commentParam("assess_c"), commentParam("attendance_c"), commentParam("difficulty_c"), commentParam("teaching_c")}
	if _, _, err := cloudflare.D1Query(ctx, sql, params); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.result(w, "评价已保存", "新评价已写入（同课程/教师/voter 已存在时按 upsert 覆盖）。", true, &session)
}

func (a *AdminServer) deleteReview(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "删除失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}
	id, err := strconv.Atoi(strings.TrimSpace(r.Form.Get("id")))
	if err != nil {
		a.result(w, "删除失败", "评价 id 不合法", false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM review_votes WHERE review_id=?`, []any{id}); err != nil {
		a.result(w, "删除失败", err.Error(), false, &session)
		return
	}
	if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM reviews WHERE id=?`, []any{id}); err != nil {
		a.result(w, "删除失败", err.Error(), false, &session)
		return
	}
	a.result(w, "评价已删除", fmt.Sprintf("已删除评价 #%d 及其投票记录。", id), true, &session)
}

// saveD1Connection validates operator-supplied D1 credentials with a real
// SELECT 1 round-trip, persists them to backend.env (0600) and hot-swaps the
// shared Cloudflare client. Token is shared with Pages management; blank token
// keeps the currently stored one.
func (a *AdminServer) saveD1Connection(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	accountID := strings.TrimSpace(r.Form.Get("cfAccountID"))
	token := strings.TrimSpace(r.Form.Get("cfAPIToken"))
	dbID := strings.TrimSpace(r.Form.Get("cfD1DatabaseID"))
	if !regexp.MustCompile(`^[0-9a-fA-F]{32}$`).MatchString(accountID) {
		a.result(w, "连接失败", "Cloudflare Account ID 应为 32 位十六进制字符串", false, &session)
		return
	}
	if !regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`).MatchString(dbID) {
		a.result(w, "连接失败", "D1 数据库 ID 格式不合法（应为 Dashboard 里的 UUID）", false, &session)
		return
	}
	current := a.cloudflareClient()
	if token == "" {
		token = current.apiToken
	}
	if len(token) < 20 || len(token) > 512 || strings.ContainsAny(token, "\r\n") {
		a.result(w, "连接失败", "Cloudflare API Token 格式不合法", false, &session)
		return
	}

	nextEnv := a.env
	nextEnv.CFAccountID = accountID
	nextEnv.CFAPIToken = token
	nextEnv.CFD1DatabaseID = dbID
	if current.project != "" {
		nextEnv.CFPagesProject = current.project
	}
	client := NewCloudflarePagesClient(nextEnv)

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, err := client.D1Query(ctx, "SELECT 1 AS ok", nil); err != nil {
		a.result(w, "连接失败", "D1 未通过验证："+err.Error()+"。请确认 Token 具有 Account / D1 / Edit 权限，且 Account ID / 库 ID 正确。", false, &session)
		return
	}

	// 若已配置 Pages 项目（两处共用同一个 CF_API_TOKEN），额外验证该 Token 仍能管理
	// Pages，避免存入一个只有 D1 权限的 Token 后把 AI 配置页打坏。
	if client.Ready() {
		if _, err := client.GetProject(ctx); err != nil {
			a.result(w, "连接失败", "该 Token 能访问 D1 但无法管理 Pages —— 两处共用同一个 CF_API_TOKEN，请生成同时具有 Account / D1 / Edit 与 Account / Cloudflare Pages / Edit 权限的 Token。原始错误："+err.Error(), false, &session)
			return
		}
	}

	if err := updateEnvironmentFile(a.env.EnvFilePath, map[string]string{
		"CF_ACCOUNT_ID":     accountID,
		"CF_API_TOKEN":      token,
		"CF_D1_DATABASE_ID": dbID,
	}); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.setCloudflareClient(client)
	a.result(w, "D1 已连接", "凭据已安全保存并立即生效。返回评价管理页即可查看与管理评价数据。", true, &session)
}

// parseResolveReport validates the resolve-report form. reportId must be a
// positive integer; deleteReview is true only for the literal "1".
func parseResolveReport(reportIDRaw, deleteRaw string) (reportID int, deleteReview bool, err error) {
	reportID, err = strconv.Atoi(strings.TrimSpace(reportIDRaw))
	if err != nil || reportID <= 0 {
		return 0, false, fmt.Errorf("举报 id 不合法")
	}
	return reportID, strings.TrimSpace(deleteRaw) == "1", nil
}

// resolveReport marks a report resolved, optionally deleting the reported review
// first. The review_id is looked up from review_reports (never trusted from the
// form); deleting a review also resolves all other open reports on it.
func (a *AdminServer) resolveReport(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "操作失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}
	reportID, deleteReview, err := parseResolveReport(r.Form.Get("reportId"), r.Form.Get("deleteReview"))
	if err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// 从 review_reports 查出关联 review_id（不信任表单）
	reviewID := 0
	reviewExists := false
	if rows, _, err := cloudflare.D1Query(ctx, `SELECT review_id FROM review_reports WHERE id=?`, []any{reportID}); err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	} else if len(rows) == 0 {
		a.result(w, "操作失败", "该举报不存在或已被处理", false, &session)
		return
	} else {
		reviewID = reviewInt(rows[0], "review_id")
	}

	deletedReview := false
	if deleteReview && reviewID > 0 {
		if rows, _, err := cloudflare.D1Query(ctx, `SELECT id FROM reviews WHERE id=?`, []any{reviewID}); err == nil && len(rows) > 0 {
			reviewExists = true
		}
		if reviewExists {
			if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM review_votes WHERE review_id=?`, []any{reviewID}); err != nil {
				a.result(w, "操作失败", err.Error(), false, &session)
				return
			}
			if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM reviews WHERE id=?`, []any{reviewID}); err != nil {
				a.result(w, "操作失败", err.Error(), false, &session)
				return
			}
			deletedReview = true
			// 该评价的其他 open 举报一并处理
			if _, _, err := cloudflare.D1Query(ctx, `UPDATE review_reports SET status='resolved' WHERE review_id=?`, []any{reviewID}); err != nil {
				a.result(w, "操作失败", err.Error(), false, &session)
				return
			}
		}
	}

	if _, _, err := cloudflare.D1Query(ctx, `UPDATE review_reports SET status='resolved' WHERE id=?`, []any{reportID}); err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}

	if deletedReview {
		a.result(w, "举报已处理", fmt.Sprintf("已删除评价 #%d 及其投票，并标记相关举报为已处理。", reviewID), true, &session)
		return
	}
	a.result(w, "举报已处理", fmt.Sprintf("已将举报 #%d 标记为已处理。", reportID), true, &session)
}

func (a *AdminServer) purgeReviews(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "清理失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}
	field := r.Form.Get("purgeField")
	value := strings.TrimSpace(r.Form.Get("purgeValue"))
	if value == "" || len(value) > 64 {
		a.result(w, "清理失败", "删除条件不能为空且不超过 64 字符", false, &session)
		return
	}
	column := map[string]string{"voter": "voter_id", "teacher": "teacher_id"}[field]
	if column == "" {
		a.result(w, "清理失败", "不支持的删除维度", false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	count := 0
	if rows, _, err := cloudflare.D1Query(ctx, `SELECT COUNT(*) AS n FROM reviews WHERE `+column+`=?`, []any{value}); err == nil && len(rows) > 0 {
		count = reviewInt(rows[0], "n")
	}
	if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM reviews WHERE `+column+`=?`, []any{value}); err != nil {
		a.result(w, "清理失败", err.Error(), false, &session)
		return
	}
	if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM review_votes WHERE review_id NOT IN (SELECT id FROM reviews)`, nil); err != nil {
		a.result(w, "清理失败", "评价已删除，但清理孤立投票失败："+err.Error(), false, &session)
		return
	}
	label := map[string]string{"voter": "voter", "teacher": "教师号"}[field]
	a.result(w, "批量清理完成", fmt.Sprintf("已删除 %s = %s 的 %d 条评价，并清理了对应的孤立投票。", label, value, count), true, &session)
}
