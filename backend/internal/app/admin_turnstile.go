package app

import (
	"context"
	"html/template"
	"net/http"
	"strings"
	"time"
)

// Turnstile 是「写评价」提交的人机验证开关。密钥存 D1 app_settings（turnstile_site_key 明文 +
// turnstile_secret），与「审核模式」(review_moderation) 同一张表、同一套面板机制——保存即生效，
// 无需重新部署。放在评价管理页、与审核模式并列。
//
// 为什么不用 Cloudflare Pages 环境变量：本仓库带 wrangler.toml（pages_build_output_dir + [vars]），
// 每次 git 构建会把不在 toml [vars] 里的明文环境变量清掉；而本仓库被 VPS 数据同步每小时 push 一次
// → 每小时构建一次 → dashboard/API 设的明文 TURNSTILE_SITE_KEY 最多活一小时（secret 类型能存活）。
// 结果就是站点密钥被反复清空、密钥留存 → 前端拿不到 site key 不渲染挂件、后端却在强制校验 →
// 所有评价提交 403。D1 不受构建清洗影响，是唯一稳的载体。
//
// 前端 functions/api/reviews/config.ts 读 turnstile_site_key 下发给挂件；
// functions/api/reviews.ts 读 turnstile_secret 做 siteverify。两者都 D1 优先、env 兜底（本地开发）。

const (
	turnstileSiteKeyRow = "turnstile_site_key"
	turnstileSecretRow  = "turnstile_secret"
)

// validTurnstileKey 宽松校验一个 Turnstile 键：非空、长度合理、单行无空白。不锁死具体格式，
// 避免 Cloudflare 未来调整 key 形态时误拒。
func validTurnstileKey(v string, max int) bool {
	if v == "" || len(v) > max {
		return false
	}
	return !strings.ContainsAny(v, " \t\r\n")
}

// turnstileCard renders the review human-verification switch (pure render).
// siteKey is the current plain site key (prefilled); secretSet reports whether a
// secret is already stored (its value is never rendered).
func (a *AdminServer) turnstileCard(session adminSession, siteKey string, secretSet bool) string {
	siteKey = strings.TrimSpace(siteKey)
	siteOn := siteKey != ""

	var badge string
	switch {
	case siteOn && secretSet:
		badge = `<span class="badge">已启用</span>`
	case siteOn || secretSet:
		badge = `<span class="badge err">配置不完整：只设了一半，写评价会全部被拒（403）——请补齐另一个键或点下方关闭</span>`
	default:
		badge = `<span class="hint">未启用：写评价无需人机验证</span>`
	}

	secretRequired := ""
	secretLabel := "Secret Key <code>turnstile_secret</code>"
	if secretSet {
		secretLabel += "（留空 = 保留现有 secret）"
	} else {
		secretRequired = " required"
	}

	var b strings.Builder
	b.WriteString(`<section class="card"><h2>人机验证（Turnstile）</h2>`)
	b.WriteString(`<p>` + badge + `</p>`)
	b.WriteString(`<p class="hint">开启后，前端「写评价」面板出现 Cloudflare Turnstile 人机验证，提交时后端强制校验。密钥存 D1（与审核模式同源），<b>保存即生效、无需重新部署</b>。两个键必须成对，缺一会导致所有评价提交被拒。</p>`)
	b.WriteString(`<p class="hint">第一步（一次性）：Cloudflare Dashboard → Turnstile → Add widget，Mode 选 Managed、Domain 填生产域名，拿到 Site Key 与 Secret Key。第二步：把两个值填到下面提交。</p>`)

	b.WriteString(`<form method="post" action="/action/save-turnstile" class="stack">` + csrf(session))
	b.WriteString(`<div class="field"><label>Site Key <code>turnstile_site_key</code></label><input name="turnstileSiteKey" maxlength="120" autocomplete="off" value="` + template.HTMLEscapeString(siteKey) + `" placeholder="0x4AAAAAAA…" required></div>`)
	b.WriteString(`<div class="field"><label>` + secretLabel + `</label><input type="password" name="turnstileSecret" maxlength="256" autocomplete="new-password" placeholder="0x4AAAAAAA…"` + secretRequired + `><p class="hint">存入 D1，页面永不回显。</p></div>`)
	b.WriteString(`<button class="button primary" type="submit">保存（即时生效）</button></form>`)

	if siteOn || secretSet {
		b.WriteString(`<form method="post" action="/action/turnstile-off" class="stack" onsubmit="return confirm('确定关闭 Turnstile？两个键会从 D1 删除，写评价立即恢复免验证。')">` + csrf(session) +
			`<button class="button" type="submit" style="background:#8b2631">关闭 Turnstile（删除两个键）</button></form>`)
	}
	b.WriteString(`</section>`)
	return b.String()
}

// saveTurnstile upserts the pair of Turnstile keys into D1 app_settings. The
// secret may be left blank to keep the existing one, but only when it is already
// stored — first-time enable requires both, so the panel can never leave the
// half-configured 403 state.
func (a *AdminServer) saveTurnstile(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "保存失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}

	siteKey := strings.TrimSpace(r.Form.Get("turnstileSiteKey"))
	secret := strings.TrimSpace(r.Form.Get("turnstileSecret"))
	if !validTurnstileKey(siteKey, 120) {
		a.result(w, "保存失败", "Site Key 不能为空、须单行且不超过 120 字符", false, &session)
		return
	}
	if secret != "" && !validTurnstileKey(secret, 256) {
		a.result(w, "保存失败", "Secret Key 须单行且不超过 256 字符", false, &session)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// secret 留空：仅当 D1 已存在非空 secret 才允许保留；否则首次启用必须两个都给（防半配 403）。
	if secret == "" {
		rows, _, err := cloudflare.D1Query(ctx, `SELECT value FROM app_settings WHERE key=?`, []any{turnstileSecretRow})
		if err != nil {
			a.result(w, "保存失败", "无法确认现有 Secret："+err.Error(), false, &session)
			return
		}
		if len(rows) == 0 || strings.TrimSpace(reviewText(rows[0], "value")) == "" {
			a.result(w, "保存失败", "首次启用必须同时填写 Secret Key（只填 Site Key 会让人机验证形同虚设）", false, &session)
			return
		}
	}

	const upsert = `INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
	if _, _, err := cloudflare.D1Query(ctx, upsert, []any{turnstileSiteKeyRow, siteKey}); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	if secret != "" {
		if _, _, err := cloudflare.D1Query(ctx, upsert, []any{turnstileSecretRow, secret}); err != nil {
			a.result(w, "保存失败", "Site Key 已存，但 Secret 写入失败："+err.Error(), false, &session)
			return
		}
	}
	// Legacy action compatibility: old bookmarks/forms still mean “use
	// Turnstile for reviews”. The new panel uses /action/save-captcha.
	for _, item := range [][2]string{{captchaProviderRow, "turnstile"}, {captchaReviewsEnabledRow, "on"}} {
		if _, _, err := cloudflare.D1Query(ctx, upsert, []any{item[0], item[1]}); err != nil {
			a.result(w, "保存失败", "Turnstile 密钥已存，但通用开关写入失败："+err.Error(), false, &session)
			return
		}
	}
	a.result(w, "Turnstile 已启用/更新", "已写入 D1（app_settings）。前端最多 1 分钟内跟上——无需重新部署。写评价将需要人机验证。", true, &session)
}

// disableTurnstile deletes both Turnstile keys from D1, restoring
// verification-free review submission.
func (a *AdminServer) disableTurnstile(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "操作失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, err := cloudflare.D1Query(ctx, `DELETE FROM app_settings WHERE key IN (?,?)`, []any{turnstileSiteKeyRow, turnstileSecretRow}); err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}
	const upsert = `INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
	for _, item := range [][2]string{{captchaProviderRow, "off"}, {captchaReviewsEnabledRow, "off"}, {captchaStudentEnabledRow, "off"}} {
		if _, _, err := cloudflare.D1Query(ctx, upsert, []any{item[0], item[1]}); err != nil {
			a.result(w, "操作失败", "Turnstile 密钥已删，但通用开关写入失败："+err.Error(), false, &session)
			return
		}
	}
	a.result(w, "Turnstile 已关闭", "已从 D1 删除两个键。前端最多 1 分钟内恢复免验证。", true, &session)
}
