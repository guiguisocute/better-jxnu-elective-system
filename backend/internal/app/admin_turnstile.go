package app

import (
	"context"
	"fmt"
	"html/template"
	"net/http"
	"strings"
	"time"
)

// Turnstile 是「写评价」提交的人机验证开关，由两个 Cloudflare Pages production 环境变量成对
// 驱动：TURNSTILE_SITE_KEY（plain_text，前端 /api/reviews/config 下发用于渲染挂件）与
// TURNSTILE_SECRET（secret_text，Functions 侧 siteverify 校验）。后端 functions/api/reviews.ts
// 的约定：SECRET 未配置 = 放行；配置了就强制校验。因此只设一半（有 SECRET 无 SITE_KEY）会让
// 所有提交拿不到 token 而被 403 —— 面板必须成对管理并显式提示这一点。
//
// 放在评价管理页，与「审核模式」并列，是运营者查找「评价人机验证」最自然的位置。开关本身走
// Pages API（与 AI 配置页同一套 CF_API_TOKEN），因此卡片会尽力拉取 Pages 配置并优雅降级。

const (
	turnstileSiteKeyEnv = "TURNSTILE_SITE_KEY"
	turnstileSecretEnv  = "TURNSTILE_SECRET"
)

// validTurnstileKey 宽松校验一个 Turnstile 键：非空、长度合理、单行无空白。不锁死具体格式，
// 避免 Cloudflare 未来调整 key 形态时误拒。
func validTurnstileKey(v string, max int) bool {
	if v == "" || len(v) > max {
		return false
	}
	return !strings.ContainsAny(v, " \t\r\n")
}

// turnstileCard renders the review human-verification switch on the reviews page.
// It best-effort reads the Pages production env vars (short timeout, independent
// context) and degrades to a hint when Pages management isn't reachable, so it
// never breaks the otherwise D1-only reviews page.
func (a *AdminServer) turnstileCard(session adminSession) string {
	const head = `<section class="card"><h2>人机验证（Turnstile）</h2>`
	cloudflare := a.cloudflareClient()
	if !cloudflare.Ready() {
		return head + `<p class="hint">此开关需要“带 Pages 权限、且填了 Pages 项目名”的 Cloudflare 连接（与 AI 配置共用同一个 Token）。请先到 <a href="/ai">AI 配置</a> 页完成 Pages 连接，再回来这里开关 Turnstile。</p></section>`
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	project, err := cloudflare.GetProject(ctx)
	if err != nil {
		return head + `<p class="hint">读取 Cloudflare Pages 配置失败：` + template.HTMLEscapeString(err.Error()) + `。可到 <a href="/ai">AI 配置</a> 页检查 Pages 连接是否仍有效。</p></section>`
	}

	vars := project.DeploymentConfigs.Production.EnvVars
	siteItem := vars[turnstileSiteKeyEnv]
	siteVal := strings.TrimSpace(siteItem.Value)
	siteOn := siteVal != "" && siteItem.Type != "secret_text"
	secretOn := vars[turnstileSecretEnv].Type == "secret_text"

	var badge string
	switch {
	case siteOn && secretOn:
		badge = `<span class="badge">已启用</span>`
	case siteOn || secretOn:
		badge = `<span class="badge err">配置不完整：只设了一半，写评价会全部被拒（403）——请补齐另一个键或点下方关闭</span>`
	default:
		badge = `<span class="hint">未启用：写评价无需人机验证</span>`
	}

	// secret 已配置时留空 = 保留现有；未配置时首次启用必填。
	secretRequired := ""
	secretLabel := "Secret Key <code>TURNSTILE_SECRET</code>"
	if secretOn {
		secretLabel += "（留空 = 保留现有 secret）"
	} else {
		secretRequired = " required"
	}

	var b strings.Builder
	b.WriteString(head)
	b.WriteString(`<p>` + badge + `</p>`)
	b.WriteString(`<p class="hint">开启后，前端「写评价」面板会出现 Cloudflare Turnstile 人机验证，提交时后端强制校验。两个键必须成对存在，缺一会导致所有评价提交被拒。保存或关闭都会自动创建一次 production 部署使其生效。</p>`)
	b.WriteString(`<p class="hint">第一步（需手动，一次性）：到 <b>Cloudflare Dashboard → Turnstile → Add widget</b>，Mode 选 Managed、Domain 填生产域名，拿到 <b>Site Key</b> 与 <b>Secret Key</b>。面板暂不能代建 widget。第二步：把两个值填到下面提交。</p>`)

	b.WriteString(`<form method="post" action="/action/save-turnstile" class="stack">` + csrf(session))
	b.WriteString(`<div class="field"><label>Site Key <code>TURNSTILE_SITE_KEY</code></label><input name="turnstileSiteKey" maxlength="120" autocomplete="off" value="` + template.HTMLEscapeString(siteVal) + `" placeholder="0x4AAAAAAA…" required></div>`)
	b.WriteString(`<div class="field"><label>` + secretLabel + `</label><input type="password" name="turnstileSecret" maxlength="256" autocomplete="new-password" placeholder="0x4AAAAAAA…"` + secretRequired + `><p class="hint">只写入 secret_text，保存后不再回显。</p></div>`)
	b.WriteString(`<button class="button primary" type="submit">保存并部署（启用 / 更新 Turnstile）</button></form>`)

	if siteOn || secretOn {
		b.WriteString(`<form method="post" action="/action/turnstile-off" class="stack" onsubmit="return confirm('确定关闭 Turnstile？两个键会被清空并部署，写评价将立即恢复免验证。')">` + csrf(session) +
			`<button class="button" type="submit" style="background:#8b2631">关闭 Turnstile（清空两个键并部署）</button></form>`)
	}
	b.WriteString(`</section>`)
	return b.String()
}

// saveTurnstile writes the pair of Turnstile env vars to Pages production and
// creates a deployment. The secret may be left blank to keep the existing one,
// but only when it is already configured — first-time enable requires both, so
// the panel can never leave the half-configured 403 state.
func (a *AdminServer) saveTurnstile(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.Ready() {
		a.result(w, "保存失败", "Cloudflare Pages API 凭据未配置（需带 Pages 权限并填 Pages 项目名）", false, &session)
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

	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	// secret 留空时：仅当现网已配置才允许（保留现有）；否则首次启用必须两个都给，
	// 以免只写 SITE_KEY 造成前端出现挂件但后端不校验（虽不 403，但形同虚设）。
	if secret == "" {
		project, err := cloudflare.GetProject(ctx)
		if err != nil {
			a.result(w, "保存失败", "无法确认现有 Secret 是否已配置："+err.Error(), false, &session)
			return
		}
		if project.DeploymentConfigs.Production.EnvVars[turnstileSecretEnv].Type != "secret_text" {
			a.result(w, "保存失败", "首次启用必须同时填写 Secret Key（只填 Site Key 会让人机验证形同虚设）", false, &session)
			return
		}
	}

	updates := map[string]CloudflareEnvVar{
		turnstileSiteKeyEnv: {Type: "plain_text", Value: siteKey},
	}
	if secret != "" {
		updates[turnstileSecretEnv] = CloudflareEnvVar{Type: "secret_text", Value: secret}
	}
	if err := cloudflare.PatchProductionEnv(ctx, updates); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	deployment, err := cloudflare.CreateProductionDeployment(ctx)
	if err != nil {
		a.result(w, "配置已保存，但部署失败", "Cloudflare 已接收环境变量；请稍后到 AI 配置页重试部署。"+err.Error(), false, &session)
		return
	}
	a.result(w, "Turnstile 已启用/更新", "已写入环境变量并创建 production 部署 "+emptyDash(deployment.ID)+"；Cloudflare 构建完成后写评价将需要人机验证。", true, &session)
}

// disableTurnstile deletes both Turnstile env vars (sending null) and deploys,
// restoring verification-free review submission.
func (a *AdminServer) disableTurnstile(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.Ready() {
		a.result(w, "操作失败", "Cloudflare Pages API 凭据未配置", false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	if err := cloudflare.DeleteProductionEnv(ctx, []string{turnstileSiteKeyEnv, turnstileSecretEnv}); err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}
	deployment, err := cloudflare.CreateProductionDeployment(ctx)
	if err != nil {
		a.result(w, "已清空环境变量，但部署失败", "两个键已删除；请稍后到 AI 配置页重试部署以使其生效。"+err.Error(), false, &session)
		return
	}
	a.result(w, "Turnstile 已关闭", fmt.Sprintf("已清空两个键并创建 production 部署 %s；构建完成后写评价恢复免验证。", emptyDash(deployment.ID)), true, &session)
}
