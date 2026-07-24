package app

import (
	"context"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	captchaProviderRow       = "captcha_provider"
	captchaReviewsEnabledRow = "captcha_reviews_enabled"
	captchaStudentEnabledRow = "captcha_student_enabled"
	capAPIEndpointRow        = "cap_api_endpoint"
	capSiteKeyRow            = "cap_site_key"
	capSecretRow             = "cap_secret"
	capWasmURLRow            = "cap_wasm_url"
)

type captchaAdminSettings struct {
	Provider           string
	ReviewsEnabled     bool
	StudentEnabled     bool
	TurnstileSiteKey   string
	TurnstileSecretSet bool
	CapAPIEndpoint     string
	CapSiteKey         string
	CapSecretSet       bool
	CapWasmURL         string
}

func validCaptchaProvider(value string) bool {
	return value == "off" || value == "turnstile" || value == "cap"
}

func settingOn(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "on", "true", "1":
		return true
	default:
		return false
	}
}

func normalizeHTTPSURL(raw string, optional bool) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" && optional {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("必须是完整 URL，且不能带账号、query 或 fragment")
	}
	host := strings.ToLower(parsed.Hostname())
	localHTTP := parsed.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
	if parsed.Scheme != "https" && !localHTTP {
		return "", fmt.Errorf("生产地址必须使用 https")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return strings.TrimRight(parsed.String(), "/"), nil
}

func (a *AdminServer) loadCaptchaSettings(ctx context.Context) (captchaAdminSettings, error) {
	cloudflare := a.cloudflareClient()
	rows, _, err := cloudflare.D1Query(ctx,
		`SELECT key, value FROM app_settings WHERE key IN (?,?,?,?,?,?,?,?,?)`,
		[]any{
			captchaProviderRow, captchaReviewsEnabledRow, captchaStudentEnabledRow,
			turnstileSiteKeyRow, turnstileSecretRow,
			capAPIEndpointRow, capSiteKeyRow, capSecretRow, capWasmURLRow,
		})
	if err != nil {
		return captchaAdminSettings{}, err
	}
	values := map[string]string{}
	for _, row := range rows {
		values[reviewText(row, "key")] = strings.TrimSpace(reviewText(row, "value"))
	}

	provider := values[captchaProviderRow]
	if !validCaptchaProvider(provider) {
		switch {
		case values[turnstileSiteKeyRow] != "" || values[turnstileSecretRow] != "":
			provider = "turnstile" // legacy Turnstile configuration
		case values[capAPIEndpointRow] != "" || values[capSiteKeyRow] != "" || values[capSecretRow] != "":
			provider = "cap"
		default:
			provider = "off"
		}
	}

	reviewsEnabled := settingOn(values[captchaReviewsEnabledRow])
	if _, explicit := values[captchaReviewsEnabledRow]; !explicit {
		// Legacy behavior: storing either Turnstile key meant reviews were meant
		// to be protected. A half-configured pair is shown as an error and fails
		// closed instead of silently dropping protection.
		reviewsEnabled = provider == "turnstile" && (values[turnstileSiteKeyRow] != "" || values[turnstileSecretRow] != "")
	}

	return captchaAdminSettings{
		Provider:           provider,
		ReviewsEnabled:     reviewsEnabled,
		StudentEnabled:     settingOn(values[captchaStudentEnabledRow]),
		TurnstileSiteKey:   values[turnstileSiteKeyRow],
		TurnstileSecretSet: values[turnstileSecretRow] != "",
		CapAPIEndpoint:     values[capAPIEndpointRow],
		CapSiteKey:         values[capSiteKeyRow],
		CapSecretSet:       values[capSecretRow] != "",
		CapWasmURL:         values[capWasmURLRow],
	}, nil
}

func captchaProviderLabel(provider string) string {
	switch provider {
	case "turnstile":
		return "Cloudflare Turnstile"
	case "cap":
		return "自托管 Cap"
	default:
		return "关闭"
	}
}

func captchaConfigured(settings captchaAdminSettings) bool {
	switch settings.Provider {
	case "turnstile":
		return settings.TurnstileSiteKey != "" && settings.TurnstileSecretSet
	case "cap":
		return settings.CapAPIEndpoint != "" && settings.CapSiteKey != "" && settings.CapSecretSet
	default:
		return false
	}
}

func secretFieldLabel(name string, set bool) (string, string) {
	if set {
		return name + "（留空 = 保留现有值）", ""
	}
	return name, ""
}

// captchaCard renders the single mutually-exclusive provider selector plus two
// independent protected actions. Provider credentials stay stored when another
// provider is selected, so switching back does not require re-entering secrets.
func (a *AdminServer) captchaCard(session adminSession, settings captchaAdminSettings, loadErr error) string {
	var badge string
	if loadErr != nil {
		badge = `<span class="badge err">读取配置失败：` + template.HTMLEscapeString(loadErr.Error()) + `</span>`
	} else if settings.Provider == "off" {
		badge = `<span class="hint">未启用：评价提交与学号查询均免验证</span>`
	} else if !captchaConfigured(settings) {
		badge = `<span class="badge err">` + captchaProviderLabel(settings.Provider) + ` 配置不完整；已勾选场景会拒绝请求（403）</span>`
	} else if !settings.ReviewsEnabled && !settings.StudentEnabled {
		badge = `<span class="hint">` + captchaProviderLabel(settings.Provider) + ` 凭据已保存，但尚未勾选保护场景</span>`
	} else {
		var scopes []string
		if settings.ReviewsEnabled {
			scopes = append(scopes, "评价提交")
		}
		if settings.StudentEnabled {
			scopes = append(scopes, "学号查询")
		}
		badge = `<span class="badge">已启用 ` + captchaProviderLabel(settings.Provider) + `：` + strings.Join(scopes, "、") + `</span>`
	}

	tsSecretLabel, _ := secretFieldLabel("Secret Key <code>turnstile_secret</code>", settings.TurnstileSecretSet)
	capSecretLabel, _ := secretFieldLabel("Site Secret <code>cap_secret</code>", settings.CapSecretSet)

	var b strings.Builder
	b.WriteString(`<section class="card"><h2>人机验证（Turnstile / Cap 互斥）</h2><p>` + badge + `</p>`)
	b.WriteString(`<p class="hint">选择一个全站 provider，再分别决定是否保护「评价提交」与「学号查询」。Turnstile 与 Cap 始终互斥；切换 provider 不会删除另一套凭据。配置写入 D1，<b>保存即生效、无需重新部署</b>。</p>`)
	b.WriteString(`<form method="post" action="/action/save-captcha" class="stack">` + csrf(session))
	b.WriteString(`<div class="choices">` +
		radio("captchaProvider", "off", "关闭", "两个场景都不做人机验证", settings.Provider) +
		radio("captchaProvider", "turnstile", "Turnstile", "Cloudflare 托管验证", settings.Provider) +
		radio("captchaProvider", "cap", "Cap", "同一台 VPS 自托管验证", settings.Provider) + `</div>`)
	b.WriteString(`<div><label class="inline"><input type="checkbox" name="captchaReviews" ` + checked(settings.ReviewsEnabled) + `>保护评价提交</label>`)
	b.WriteString(`<label class="inline"><input type="checkbox" name="captchaStudent" ` + checked(settings.StudentEnabled) + `>保护学号查询</label></div>`)

	b.WriteString(`<div class="grid three"><div><h3>Cloudflare Turnstile</h3>`)
	b.WriteString(`<div class="field"><label>Site Key <code>turnstile_site_key</code></label><input name="turnstileSiteKey" maxlength="120" autocomplete="off" value="` + template.HTMLEscapeString(settings.TurnstileSiteKey) + `" placeholder="0x4AAAAAAA…"></div>`)
	b.WriteString(`<div class="field"><label>` + tsSecretLabel + `</label><input type="password" name="turnstileSecret" maxlength="256" autocomplete="new-password" placeholder="0x4AAAAAAA…"><p class="hint">Secret 永不回显。</p></div></div>`)

	b.WriteString(`<div style="grid-column:span 2"><h3>自托管 Cap</h3>`)
	b.WriteString(`<div class="field"><label>公开 API 根地址 <code>cap_api_endpoint</code></label><input name="capApiEndpoint" maxlength="300" autocomplete="off" value="` + template.HTMLEscapeString(settings.CapAPIEndpoint) + `" placeholder="https://getxk.jxnu-publish.asia/cap"><p class="hint">填到 Cap 实例根路径，不含 site key；前端会拼成 /&lt;site-key&gt;/，Pages Function 会拼 /siteverify。</p></div>`)
	b.WriteString(`<div class="field"><label>Site Key <code>cap_site_key</code></label><input name="capSiteKey" maxlength="128" autocomplete="off" value="` + template.HTMLEscapeString(settings.CapSiteKey) + `" placeholder="d9256640cb53"></div>`)
	b.WriteString(`<div class="field"><label>` + capSecretLabel + `</label><input type="password" name="capSecret" maxlength="256" autocomplete="new-password"><p class="hint">这里填站点 secret，不是 Cap 控制台 ADMIN_KEY；永不回显。</p></div>`)
	b.WriteString(`<div class="field"><label>WASM 地址（可选）<code>cap_wasm_url</code></label><input name="capWasmUrl" maxlength="400" autocomplete="off" value="` + template.HTMLEscapeString(settings.CapWasmURL) + `" placeholder="https://getxk.jxnu-publish.asia/cap/assets/cap_wasm_bg.wasm"><p class="hint">留空时按 API 根地址自动推导 /assets/cap_wasm_bg.wasm。</p></div></div></div>`)
	b.WriteString(`<button class="button primary" type="submit">保存人机验证配置（即时生效）</button></form>`)
	if settings.Provider != "off" || settings.ReviewsEnabled || settings.StudentEnabled {
		b.WriteString(`<form method="post" action="/action/captcha-off" class="stack" onsubmit="return confirm('确定关闭所有人机验证？已保存的 Turnstile/Cap 凭据会保留，之后可一键重新启用。')">` + csrf(session) + `<button class="button" type="submit" style="background:#8b2631">关闭所有人机验证（保留凭据）</button></form>`)
	}
	b.WriteString(`</section>`)
	return b.String()
}

func (a *AdminServer) saveCaptcha(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		a.result(w, "保存失败", "Cloudflare D1 凭据未配置", false, &session)
		return
	}

	provider := strings.TrimSpace(r.Form.Get("captchaProvider"))
	if !validCaptchaProvider(provider) {
		a.result(w, "保存失败", "人机验证 provider 不合法", false, &session)
		return
	}
	reviewsEnabled := r.Form.Get("captchaReviews") == "on"
	studentEnabled := r.Form.Get("captchaStudent") == "on"
	turnstileSiteKey := strings.TrimSpace(r.Form.Get("turnstileSiteKey"))
	turnstileSecret := strings.TrimSpace(r.Form.Get("turnstileSecret"))
	capEndpointRaw := strings.TrimSpace(r.Form.Get("capApiEndpoint"))
	capSiteKey := strings.TrimSpace(r.Form.Get("capSiteKey"))
	capSecret := strings.TrimSpace(r.Form.Get("capSecret"))
	capWasmRaw := strings.TrimSpace(r.Form.Get("capWasmUrl"))

	if turnstileSiteKey != "" && !validTurnstileKey(turnstileSiteKey, 120) {
		a.result(w, "保存失败", "Turnstile Site Key 须单行且不超过 120 字符", false, &session)
		return
	}
	if turnstileSecret != "" && !validTurnstileKey(turnstileSecret, 256) {
		a.result(w, "保存失败", "Turnstile Secret 须单行且不超过 256 字符", false, &session)
		return
	}
	if capSiteKey != "" && !validTurnstileKey(capSiteKey, 128) {
		a.result(w, "保存失败", "Cap Site Key 须单行且不超过 128 字符", false, &session)
		return
	}
	if capSecret != "" && !validTurnstileKey(capSecret, 256) {
		a.result(w, "保存失败", "Cap Site Secret 须单行且不超过 256 字符", false, &session)
		return
	}

	capEndpoint, err := normalizeHTTPSURL(capEndpointRaw, true)
	if err != nil {
		a.result(w, "保存失败", "Cap API 根地址"+err.Error(), false, &session)
		return
	}
	capWasmURL, err := normalizeHTTPSURL(capWasmRaw, true)
	if err != nil {
		a.result(w, "保存失败", "Cap WASM 地址"+err.Error(), false, &session)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	current, loadErr := a.loadCaptchaSettings(ctx)
	if loadErr != nil {
		a.result(w, "保存失败", "无法读取当前配置："+loadErr.Error(), false, &session)
		return
	}

	if provider == "turnstile" && (reviewsEnabled || studentEnabled) {
		if turnstileSiteKey == "" || (turnstileSecret == "" && !current.TurnstileSecretSet) {
			a.result(w, "保存失败", "启用 Turnstile 时必须有完整的 Site Key 与 Secret Key", false, &session)
			return
		}
	}
	if provider == "cap" && (reviewsEnabled || studentEnabled) {
		if capEndpoint == "" || capSiteKey == "" || (capSecret == "" && !current.CapSecretSet) {
			a.result(w, "保存失败", "启用 Cap 时必须有 API 根地址、Site Key 与 Site Secret", false, &session)
			return
		}
	}

	const upsert = `INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
	updates := [][2]string{
		{captchaProviderRow, provider},
		{captchaReviewsEnabledRow, map[bool]string{true: "on", false: "off"}[reviewsEnabled]},
		{captchaStudentEnabledRow, map[bool]string{true: "on", false: "off"}[studentEnabled]},
		{turnstileSiteKeyRow, turnstileSiteKey},
		{capAPIEndpointRow, capEndpoint},
		{capSiteKeyRow, capSiteKey},
		{capWasmURLRow, capWasmURL},
	}
	if turnstileSecret != "" {
		updates = append(updates, [2]string{turnstileSecretRow, turnstileSecret})
	}
	if capSecret != "" {
		updates = append(updates, [2]string{capSecretRow, capSecret})
	}
	for _, item := range updates {
		if _, _, err := cloudflare.D1Query(ctx, upsert, []any{item[0], item[1]}); err != nil {
			a.result(w, "保存失败", "写入 "+item[0]+" 失败："+err.Error(), false, &session)
			return
		}
	}

	scopes := []string{}
	if reviewsEnabled {
		scopes = append(scopes, "评价提交")
	}
	if studentEnabled {
		scopes = append(scopes, "学号查询")
	}
	detail := "provider=" + captchaProviderLabel(provider)
	if len(scopes) > 0 {
		detail += "；保护：" + strings.Join(scopes, "、")
	} else {
		detail += "；未勾选保护场景"
	}
	a.result(w, "人机验证配置已保存", detail+"。前端最多 1 分钟内跟上，无需重新部署。", true, &session)
}

func (a *AdminServer) disableCaptcha(w http.ResponseWriter, r *http.Request, session adminSession) {
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
	const upsert = `INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
	for _, item := range [][2]string{{captchaProviderRow, "off"}, {captchaReviewsEnabledRow, "off"}, {captchaStudentEnabledRow, "off"}} {
		if _, _, err := cloudflare.D1Query(ctx, upsert, []any{item[0], item[1]}); err != nil {
			a.result(w, "操作失败", err.Error(), false, &session)
			return
		}
	}
	a.result(w, "人机验证已关闭", "Turnstile 与 Cap 凭据均已保留；评价提交和学号查询恢复免验证。", true, &session)
}
