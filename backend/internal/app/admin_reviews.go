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
	if q != "" {
		sql += " WHERE " + fieldColumn + " LIKE ?"
		params = append(params, "%"+q+"%")
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

	totalReviews, totalVotes := 0, 0
	if stat, _, err := cloudflare.D1Query(ctx, `SELECT (SELECT COUNT(*) FROM reviews) AS reviews, (SELECT COUNT(*) FROM review_votes) AS votes`, nil); err == nil && len(stat) > 0 {
		totalReviews = reviewInt(stat[0], "reviews")
		totalVotes = reviewInt(stat[0], "votes")
	}

	var b strings.Builder
	b.WriteString(`<section class="hero"><div><p class="eyebrow">评价管理</p><h1>学生课程评价监管</h1><p>直连 Cloudflare D1 库 jxnu-ratings，可查看、编辑、删除与批量清理评价。</p></div><a class="button primary" href="/reviews/edit">手工补录评价</a></section>`)

	// stats
	b.WriteString(fmt.Sprintf(`<div class="grid three"><section class="card"><h2>总评价数</h2><p class="big">%d</p></section><section class="card"><h2>总投票数</h2><p class="big">%d</p></section><section class="card"><h2>当前页</h2><p class="big">第 %d 页</p><p class="hint">每页 %d 条</p></section></div>`, totalReviews, totalVotes, page, reviewPageSize))

	// search form
	sel := func(v, label string) string {
		s := ""
		if field == v {
			s = " selected"
		}
		return `<option value="` + v + `"` + s + `>` + label + `</option>`
	}
	b.WriteString(`<section class="card"><h2>搜索</h2><form method="get" action="/reviews" class="searchbar"><select name="field">` +
		sel("course", "课程号") + sel("teacher", "教师号") + sel("voter", "voter") +
		`</select><input name="q" value="` + template.HTMLEscapeString(q) + `" placeholder="输入搜索词" maxlength="64"><button class="button" type="submit">搜索</button></form></section>`)

	// table
	b.WriteString(`<section class="card"><h2>评价列表</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>id</th><th>课程号</th><th>教师号</th><th>voter</th><th>昵称</th><th>头像</th>`)
	for _, d := range reviewDimensions {
		b.WriteString(`<th>` + d.Label + `</th>`)
	}
	for _, d := range reviewDimensions {
		b.WriteString(`<th>` + d.Label + `评语</th>`)
	}
	b.WriteString(`<th>有用</th><th>更新时间</th><th>操作</th></tr></thead><tbody>`)

	if len(rows) == 0 {
		b.WriteString(`<tr><td colspan="19">没有匹配的评价</td></tr>`)
	}
	for _, row := range rows {
		id := reviewInt(row, "id")
		b.WriteString(`<tr>`)
		b.WriteString(`<td>` + strconv.Itoa(id) + `</td>`)
		b.WriteString(`<td>` + template.HTMLEscapeString(reviewText(row, "course_id")) + `</td>`)
		b.WriteString(`<td>` + template.HTMLEscapeString(reviewText(row, "teacher_id")) + `</td>`)
		b.WriteString(`<td title="` + template.HTMLEscapeString(reviewText(row, "voter_id")) + `">` + template.HTMLEscapeString(truncateRunes(reviewText(row, "voter_id"), 8)) + `</td>`)
		b.WriteString(`<td>` + template.HTMLEscapeString(reviewText(row, "nickname")) + `</td>`)
		b.WriteString(`<td>` + template.HTMLEscapeString(reviewText(row, "avatar")) + `</td>`)
		for _, d := range reviewDimensions {
			b.WriteString(`<td>` + reviewScoreCell(row, d.Score) + `</td>`)
		}
		for _, d := range reviewDimensions {
			full := reviewText(row, d.Comment)
			if strings.TrimSpace(full) == "" {
				b.WriteString(`<td>—</td>`)
			} else {
				b.WriteString(`<td title="` + template.HTMLEscapeString(full) + `">` + template.HTMLEscapeString(truncateRunes(full, 60)) + `</td>`)
			}
		}
		b.WriteString(`<td>` + strconv.Itoa(reviewInt(row, "helpful")) + `</td>`)
		b.WriteString(`<td>` + template.HTMLEscapeString(reviewText(row, "updated_at")) + `</td>`)
		b.WriteString(`<td><a href="/reviews/edit?id=` + strconv.Itoa(id) + `">编辑</a> <form method="post" action="/action/delete-review">` + csrf(session) + `<input type="hidden" name="id" value="` + strconv.Itoa(id) + `"><button class="link" type="submit" style="color:#c0363f">删除</button></form></td>`)
		b.WriteString(`</tr>`)
	}
	b.WriteString(`</tbody></table></div>`)

	// pager
	b.WriteString(`<div class="pager">`)
	if page > 1 {
		b.WriteString(`<a class="button" href="` + reviewListURL(q, field, page-1) + `">上一页</a>`)
	}
	if len(rows) == reviewPageSize {
		b.WriteString(`<a class="button" href="` + reviewListURL(q, field, page+1) + `">下一页</a>`)
	}
	b.WriteString(`</div></section>`)

	// batch purge
	b.WriteString(`<section class="card"><h2>批量清理（精确匹配）</h2><p class="hint">按精确的 voter 或教师号删除全部评价，删除前会统计条数并在结果中反馈。此操作不可恢复。</p><div class="grid three">`)
	b.WriteString(`<form method="post" action="/action/purge-reviews" class="stack">` + csrf(session) + `<input type="hidden" name="purgeField" value="voter"><div class="field"><label>按 voter 精确删除</label><input name="purgeValue" maxlength="64" required></div><button class="button" type="submit">删除该 voter 的评价</button></form>`)
	b.WriteString(`<form method="post" action="/action/purge-reviews" class="stack">` + csrf(session) + `<input type="hidden" name="purgeField" value="teacher"><div class="field"><label>按教师号精确删除</label><input name="purgeValue" maxlength="64" required></div><button class="button" type="submit">删除该教师的评价</button></form>`)
	b.WriteString(`</div></section>`)

	a.render(w, "评价管理", b.String(), &session)
}

func reviewListURL(q, field string, page int) string {
	v := fmt.Sprintf("/reviews?field=%s&page=%d", field, page)
	if q != "" {
		v += "&q=" + template.URLQueryEscaper(q)
	}
	return v
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
