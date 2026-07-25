package app

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 回收站：面板里的「删除评价」不再直接 DELETE，而是先把整行连同它的「有用」票快照
// 进 review_trash，再从 reviews 删除。前台读的是 reviews，所以对访客而言效果与硬删
// 完全一样；但管理端多了一条可回头的路——误删可以原样还原，包括评价 id 和投票。
//
// 保留策略：不自动过期。回收站条目很少（一条评价几百字节），而「误删难还原」正是要
// 解决的问题，静默清理会把它带回来。要腾空间时在页面上手动清 N 天前。

const trashPageSize = 20

// reviewColumns is the whitelist of columns a trashed snapshot may restore into
// `reviews`. Restore builds its INSERT from this list, never from the JSON's own
// keys, so a hand-edited snapshot can't inject an identifier into the SQL.
var reviewColumns = []string{
	"course_id", "teacher_id", "voter_id", "avatar", "nickname",
	"overall", "assess", "attendance", "difficulty", "teaching",
	"overall_c", "assess_c", "attendance_c", "difficulty_c", "teaching_c",
	"status", "created_at", "updated_at",
}

var trashSourceLabels = map[string]string{
	"manual": "手动删除",
	"report": "举报处理时删除",
	"purge":  "批量清理",
}

func trashSourceLabel(source string) string {
	if label, ok := trashSourceLabels[source]; ok {
		return label
	}
	return source
}

// trashReview snapshots one review (and its votes) into review_trash and then
// removes it from the live tables. Returns the snapshot row so callers can put
// it in their audit entry, or nil when the review no longer exists.
//
// The snapshot is written before the deletes on purpose: if the process dies
// mid-way the worst outcome is a trash entry for a review that still exists,
// which is harmless and visible, rather than a review that is gone with no copy.
func (a *AdminServer) trashReview(ctx context.Context, actor string, reviewID int, source string) (map[string]any, error) {
	cloudflare := a.cloudflareClient()
	if err := a.EnsureReviewOpsTables(ctx); err != nil {
		return nil, err
	}

	loaded := cloudflare.D1Many(ctx, []D1Statement{
		{SQL: `SELECT * FROM reviews WHERE id=?`, Params: []any{reviewID}},
		{SQL: `SELECT voter_id, created_at FROM review_votes WHERE review_id=?`, Params: []any{reviewID}},
	})
	if err := firstD1Error(loaded); err != nil {
		return nil, err
	}
	reviewRows := d1Rows(loaded, 0)
	if len(reviewRows) == 0 {
		return nil, nil
	}
	row := reviewRows[0]

	payload, err := json.Marshal(row)
	if err != nil {
		return nil, fmt.Errorf("序列化评价快照失败: %w", err)
	}
	votes, err := json.Marshal(d1Rows(loaded, 1))
	if err != nil {
		return nil, fmt.Errorf("序列化投票快照失败: %w", err)
	}

	if _, _, err := cloudflare.D1Query(ctx,
		`INSERT INTO review_trash (review_id, course_id, teacher_id, voter_id, payload, votes, deleted_by, source)
		 VALUES (?,?,?,?,?,?,?,?)`,
		[]any{reviewID, reviewText(row, "course_id"), reviewText(row, "teacher_id"), reviewText(row, "voter_id"),
			string(payload), string(votes), actor, source}); err != nil {
		return nil, err
	}

	removed := cloudflare.D1Many(ctx, []D1Statement{
		{SQL: `DELETE FROM review_votes WHERE review_id=?`, Params: []any{reviewID}},
		{SQL: `DELETE FROM reviews WHERE id=?`, Params: []any{reviewID}},
	})
	if err := firstD1Error(removed); err != nil {
		return nil, err
	}
	return row, nil
}

func (a *AdminServer) trashPage(w http.ResponseWriter, r *http.Request, session adminSession) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.reviewD1Unavailable(w, session)
		return
	}
	showRestored := r.URL.Query().Get("show") == "restored"
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}

	ctx, cancel := context.WithTimeout(r.Context(), D1RequestTimeout)
	defer cancel()
	if err := a.EnsureReviewOpsTables(ctx); err != nil {
		a.render(w, "回收站", reviewsSubnav("trash")+a.reviewD1SetupForm(session, err.Error()), &session)
		return
	}

	filter := `restored_at IS NULL`
	if showRestored {
		filter = `restored_at IS NOT NULL`
	}
	results := cloudflare.D1Many(ctx, []D1Statement{
		{SQL: `SELECT * FROM review_trash WHERE ` + filter + ` ORDER BY id DESC LIMIT ? OFFSET ?`,
			Params: []any{trashPageSize, (page - 1) * trashPageSize}},
		{SQL: `SELECT (SELECT COUNT(*) FROM review_trash WHERE restored_at IS NULL) AS pending,
		              (SELECT COUNT(*) FROM review_trash WHERE restored_at IS NOT NULL) AS restored`},
	})
	if err := firstD1Error(results); err != nil {
		a.render(w, "回收站", reviewsSubnav("trash")+a.reviewD1SetupForm(session, err.Error()), &session)
		return
	}
	rows := d1Rows(results, 0)
	pending, restored := 0, 0
	if stat := d1Rows(results, 1); len(stat) > 0 {
		pending = reviewInt(stat[0], "pending")
		restored = reviewInt(stat[0], "restored")
	}

	courseName, teacherName := a.reviewNames()

	var b strings.Builder
	b.WriteString(`<section class="hero"><div><p class="eyebrow">评价管理</p><h1>回收站</h1><p>面板删除的评价会连同它的「有用」票整行快照到这里，可以原样还原（含原评价 id）。回收站不会自动清空。</p></div></section>`)
	b.WriteString(reviewsSubnav("trash"))
	b.WriteString(fmt.Sprintf(`<div class="grid three"><section class="card"><h2>待还原</h2><p class="big">%d</p><p class="hint">仍在回收站中</p></section><section class="card"><h2>已还原</h2><p class="big">%d</p><p class="hint">留档，不再占用列表</p></section><section class="card"><h2>当前页</h2><p class="big">第 %d 页</p><p class="hint">每页 %d 条</p></section></div>`, pending, restored, page, trashPageSize))

	tab := func(label, value string, active bool) string {
		class := "button"
		if active {
			class = "button primary"
		}
		return `<a class="` + class + `" href="/reviews/trash?show=` + value + `">` + label + `</a>`
	}
	b.WriteString(`<section class="card"><div class="action-row">` +
		tab("待还原", "pending", !showRestored) + tab("已还原（留档）", "restored", showRestored) + `</div></section>`)

	b.WriteString(`<section class="card"><h2>` + map[bool]string{true: "已还原记录", false: "已删除的评价"}[showRestored] + `</h2>`)
	if len(rows) == 0 {
		b.WriteString(`<p class="hint">这里是空的。</p>`)
	}
	for _, row := range rows {
		b.WriteString(renderTrashItem(row, session, courseName, teacherName, showRestored))
	}
	b.WriteString(`<div class="pager">`)
	if page > 1 {
		b.WriteString(`<a class="button" href="` + trashListURL(showRestored, page-1) + `">上一页</a>`)
	}
	if len(rows) == trashPageSize {
		b.WriteString(`<a class="button" href="` + trashListURL(showRestored, page+1) + `">下一页</a>`)
	}
	b.WriteString(`</div></section>`)

	b.WriteString(`<section class="card"><h2>清理回收站</h2><p class="hint">彻底删除指定天数之前的回收站条目。这一步不可恢复——被清掉的评价就真的没有副本了。</p>` +
		`<form method="post" action="/action/purge-trash" class="stack" onsubmit="return confirm('确定彻底删除这些回收站条目？此操作不可恢复。')">` + csrf(session) +
		`<div class="field"><label>删除多少天前进入回收站的条目</label><input type="number" name="days" value="90" min="1" max="3650" required></div>` +
		`<button class="button" type="submit" style="background:#8b2631">彻底清理</button></form></section>`)

	a.render(w, "回收站", b.String(), &session)
}

func trashListURL(showRestored bool, page int) string {
	show := "pending"
	if showRestored {
		show = "restored"
	}
	return fmt.Sprintf("/reviews/trash?show=%s&page=%d", show, page)
}

// renderTrashItem shows a trashed review using the same card visual as the live
// list, rebuilt from the JSON snapshot, plus its deletion metadata.
func renderTrashItem(row map[string]any, session adminSession, courseName, teacherName func(id string) string, restoredView bool) string {
	trashID := reviewInt(row, "id")
	var snapshot map[string]any
	if err := json.Unmarshal([]byte(reviewText(row, "payload")), &snapshot); err != nil {
		snapshot = nil
	}

	var b strings.Builder
	b.WriteString(`<div class="report-item">`)
	b.WriteString(`<p class="hint">` + template.HTMLEscapeString(trashSourceLabel(reviewText(row, "source"))) +
		` · ` + template.HTMLEscapeString(reviewText(row, "deleted_at")) + ` UTC` +
		` · 操作者 ` + template.HTMLEscapeString(reviewText(row, "deleted_by")) +
		` · 原评价 #` + strconv.Itoa(reviewInt(row, "review_id")) +
		` · 回收站 #` + strconv.Itoa(trashID) + `</p>`)
	if restoredAt := strings.TrimSpace(reviewText(row, "restored_at")); restoredAt != "" {
		b.WriteString(`<p><span class="badge">已于 ` + template.HTMLEscapeString(restoredAt) + ` UTC 还原</span></p>`)
	}

	if snapshot == nil {
		b.WriteString(`<p class="hint">快照无法解析，只能看到上面的元信息。</p>`)
	} else {
		b.WriteString(renderTrashCard(snapshot, courseName, teacherName))
	}

	if !restoredView {
		b.WriteString(`<div class="rev-actions">`)
		b.WriteString(`<form method="post" action="/action/restore-review">` + csrf(session) +
			`<input type="hidden" name="trashId" value="` + strconv.Itoa(trashID) + `"><button class="button primary" type="submit">还原</button></form>`)
		b.WriteString(`<form method="post" action="/action/purge-trash" onsubmit="return confirm('彻底删除这条回收站记录？之后无法再还原。')">` + csrf(session) +
			`<input type="hidden" name="trashId" value="` + strconv.Itoa(trashID) + `"><button class="link" type="submit" style="color:#c0363f">彻底删除</button></form>`)
		b.WriteString(`</div>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

// renderTrashCard renders a snapshot read-only: same layout as renderReviewCard
// but without the live-row actions (edit/approve/delete make no sense here).
func renderTrashCard(row map[string]any, courseName, teacherName func(id string) string) string {
	courseID := reviewText(row, "course_id")
	teacherID := reviewText(row, "teacher_id")
	cName := courseName(courseID)
	if cName == "" {
		cName = "未知课程"
	}
	tName := teacherName(teacherID)
	if tName == "" {
		tName = "未知教师"
	}
	nickname := strings.TrimSpace(reviewText(row, "nickname"))
	if nickname == "" {
		nickname = "匿名同学"
	}

	var b strings.Builder
	b.WriteString(`<div class="rev"><div class="rev-head"><div class="rev-title">` +
		template.HTMLEscapeString(cName) + ` <code>` + template.HTMLEscapeString(courseID) + `</code> · ` +
		template.HTMLEscapeString(tName) + ` <code>` + template.HTMLEscapeString(teacherID) + `</code></div></div>`)
	b.WriteString(`<p class="hint rev-meta">` + template.HTMLEscapeString(nickname) +
		` · ` + template.HTMLEscapeString(truncateRunes(reviewText(row, "voter_id"), 8)) +
		` · ` + template.HTMLEscapeString(reviewText(row, "updated_at")) + `</p>`)
	b.WriteString(`<div class="rev-chips">`)
	for _, d := range reviewDimMetas {
		score, has := reviewFloat(row, d.Score)
		if !has {
			continue
		}
		b.WriteString(`<span class="rev-chip" style="background:` + d.Color + `1A;color:` + d.Color + `">` +
			template.HTMLEscapeString(d.Chip) + ` ★` + strconv.FormatFloat(score, 'f', -1, 64) + `</span>`)
	}
	b.WriteString(`</div>`)
	for _, d := range reviewDimMetas {
		full := strings.TrimSpace(reviewText(row, d.Comment))
		if full == "" {
			continue
		}
		b.WriteString(`<div class="rev-quote" style="border-color:` + d.Color + `"><span class="rev-quote-label" style="color:` + d.Color + `">` +
			template.HTMLEscapeString(d.Chip) + `</span>` + template.HTMLEscapeString(full) + `</div>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

// restoreReview puts a trashed review back into `reviews`, keeping its original
// id when that id is still free, and restores its votes.
func (a *AdminServer) restoreReview(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "还原失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}
	trashID, err := strconv.Atoi(strings.TrimSpace(r.Form.Get("trashId")))
	if err != nil || trashID <= 0 {
		a.result(w, "还原失败", "回收站 id 不合法", false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), D1RequestTimeout)
	defer cancel()
	if err := a.EnsureReviewOpsTables(ctx); err != nil {
		a.result(w, "还原失败", err.Error(), false, &session)
		return
	}

	trashRows, _, err := cloudflare.D1Query(ctx, `SELECT * FROM review_trash WHERE id=? AND restored_at IS NULL`, []any{trashID})
	if err != nil {
		a.result(w, "还原失败", err.Error(), false, &session)
		return
	}
	if len(trashRows) == 0 {
		a.result(w, "还原失败", "该回收站条目不存在，或已经还原过了", false, &session)
		return
	}
	trash := trashRows[0]

	var snapshot map[string]any
	if err := json.Unmarshal([]byte(reviewText(trash, "payload")), &snapshot); err != nil {
		a.result(w, "还原失败", "快照不是合法 JSON，无法还原："+err.Error(), false, &session)
		return
	}
	originalID := reviewInt(trash, "review_id")
	courseID := reviewText(trash, "course_id")
	teacherID := reviewText(trash, "teacher_id")
	voterID := reviewText(trash, "voter_id")

	// 两个冲突要分开看：同一个 (课程,教师,voter) 已经有活着的评价（用户删除后又重新
	// 评了），还原会撞 UNIQUE —— 这种情况宁可停下来让人决定，也不能悄悄覆盖新评价。
	// 原 id 被占用则无所谓，交给 AUTOINCREMENT 发一个新的。
	checks := cloudflare.D1Many(ctx, []D1Statement{
		{SQL: `SELECT id FROM reviews WHERE course_id=? AND teacher_id=? AND voter_id=?`, Params: []any{courseID, teacherID, voterID}},
		{SQL: `SELECT id FROM reviews WHERE id=?`, Params: []any{originalID}},
	})
	if err := firstD1Error(checks); err != nil {
		a.result(w, "还原失败", err.Error(), false, &session)
		return
	}
	if live := d1Rows(checks, 0); len(live) > 0 {
		a.result(w, "还原失败", fmt.Sprintf(
			"该同学已经对这门课/这位老师重新写了一条评价（#%d）。还原会覆盖那条新评价，所以这里不自动执行——请先处理现有评价（编辑或删除）再还原。",
			reviewInt(live[0], "id")), false, &session)
		return
	}
	keepID := len(d1Rows(checks, 1)) == 0

	columns := append([]string{}, reviewColumns...)
	params := make([]any, 0, len(columns)+1)
	if keepID {
		columns = append([]string{"id"}, columns...)
		params = append(params, originalID)
	}
	for _, column := range reviewColumns {
		params = append(params, snapshot[column])
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(columns)), ",")
	// columns comes from the reviewColumns whitelist, never from the snapshot.
	if _, _, err := cloudflare.D1Query(ctx,
		`INSERT INTO reviews (`+strings.Join(columns, ",")+`) VALUES (`+placeholders+`)`, params); err != nil {
		a.result(w, "还原失败", err.Error(), false, &session)
		return
	}

	newID := originalID
	if !keepID {
		idRows, _, err := cloudflare.D1Query(ctx, `SELECT id FROM reviews WHERE course_id=? AND teacher_id=? AND voter_id=?`, []any{courseID, teacherID, voterID})
		if err != nil || len(idRows) == 0 {
			a.result(w, "部分还原", "评价已写回，但没能读到新的评价 id，投票未还原。请到评价列表确认。", false, &session)
			return
		}
		newID = reviewInt(idRows[0], "id")
	}

	restoredVotes := a.restoreVotes(ctx, reviewText(trash, "votes"), newID)

	if _, _, err := cloudflare.D1Query(ctx, `UPDATE review_trash SET restored_at=datetime('now') WHERE id=?`, []any{trashID}); err != nil {
		a.logger.Warn("标记回收站条目已还原失败", "trashId", trashID, "error", err)
	}

	detail := fmt.Sprintf("已还原评价 #%d（回收站 #%d），并恢复 %d 条「有用」票。", newID, trashID, restoredVotes)
	if !keepID {
		detail += fmt.Sprintf("原 id #%d 已被占用，新分配了 #%d。", originalID, newID)
	}
	a.audit(ctx, r, auditEntry{
		Action: auditRestoreReview,
		Target: fmt.Sprintf("review #%d", newID),
		Detail: detail,
		After:  snapshot,
	})
	a.result(w, "评价已还原", detail, true, &session)
}

// restoreVotes re-inserts the snapshotted helpful votes. Best-effort: a review
// that came back without its votes is far better than a failed restore, so
// errors are logged and counted, not surfaced as failure.
func (a *AdminServer) restoreVotes(ctx context.Context, raw string, reviewID int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return 0
	}
	var votes []map[string]any
	if err := json.Unmarshal([]byte(raw), &votes); err != nil || len(votes) == 0 {
		return 0
	}
	statements := make([]D1Statement, 0, len(votes))
	for _, vote := range votes {
		voter := reviewText(vote, "voter_id")
		if voter == "" {
			continue
		}
		createdAt := reviewText(vote, "created_at")
		statements = append(statements, D1Statement{
			SQL:    `INSERT OR IGNORE INTO review_votes (review_id, voter_id, created_at) VALUES (?,?,?)`,
			Params: []any{reviewID, voter, createdAt},
		})
	}
	restored := 0
	for _, result := range a.cloudflareClient().D1Many(ctx, statements) {
		if result.Err != nil {
			a.logger.Warn("还原「有用」票失败", "reviewId", reviewID, "error", result.Err)
			continue
		}
		restored++
	}
	return restored
}

// purgeTrash permanently removes trash entries — either one entry by id, or
// everything deleted more than N days ago.
func (a *AdminServer) purgeTrash(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "清理失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), D1RequestTimeout)
	defer cancel()
	if err := a.EnsureReviewOpsTables(ctx); err != nil {
		a.result(w, "清理失败", err.Error(), false, &session)
		return
	}

	if raw := strings.TrimSpace(r.Form.Get("trashId")); raw != "" {
		trashID, err := strconv.Atoi(raw)
		if err != nil || trashID <= 0 {
			a.result(w, "清理失败", "回收站 id 不合法", false, &session)
			return
		}
		if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM review_trash WHERE id=?`, []any{trashID}); err != nil {
			a.result(w, "清理失败", err.Error(), false, &session)
			return
		}
		detail := fmt.Sprintf("已彻底删除回收站条目 #%d，无法再还原。", trashID)
		a.audit(ctx, r, auditEntry{Action: auditPurgeTrash, Target: fmt.Sprintf("trash #%d", trashID), Detail: detail})
		a.result(w, "已彻底删除", detail, true, &session)
		return
	}

	days, err := strconv.Atoi(strings.TrimSpace(r.Form.Get("days")))
	if err != nil || days < 1 || days > 3650 {
		a.result(w, "清理失败", "天数必须是 1–3650 之间的整数", false, &session)
		return
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02 15:04:05")
	count := 0
	if rows, _, err := cloudflare.D1Query(ctx, `SELECT COUNT(*) AS n FROM review_trash WHERE deleted_at < ?`, []any{cutoff}); err == nil && len(rows) > 0 {
		count = reviewInt(rows[0], "n")
	}
	if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM review_trash WHERE deleted_at < ?`, []any{cutoff}); err != nil {
		a.result(w, "清理失败", err.Error(), false, &session)
		return
	}
	detail := fmt.Sprintf("已彻底删除 %d 天前（%s UTC 之前）进入回收站的 %d 条记录。", days, cutoff, count)
	a.audit(ctx, r, auditEntry{Action: auditPurgeTrash, Target: fmt.Sprintf("older than %dd", days), Detail: detail})
	a.result(w, "回收站已清理", detail, true, &session)
}
