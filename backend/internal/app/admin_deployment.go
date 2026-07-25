package app

import (
	"context"
	"crypto/subtle"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

// 部署配置：fork 自部署时唯一需要从零填的一页。
//
// 在这一页出现之前，「这套东西部署在哪个域名下」这件事散落在四个地方：源码里的
// 默认常量、config.json 的 CORS 白名单、backend.env、以及仓库里的 wrangler.toml。
// 其中前端兜底地址和 D1 库 ID 直接写着上游作者的域名与资源，于是 fork 出来的站点
// 要么在无声地请求上游的 VPS，要么撞上一条看不懂的鉴权错误。
//
// 现在的规则：站点身份（siteOrigin / backendPublicUrl）存 config.json，凭据存
// backend.env（0600），两者都能在这一页改完；改完之后这一页还会把前端那侧要填的
// 三个值和一段 Caddy 配置直接生成出来，照抄即可，不用去源码里找。

// deploymentRestartUnit is the systemd unit this binary runs as. Only used for
// the panel's restart button and the copy-paste hints.
const deploymentRestartUnit = "jxnu-backend.service"

// Shared credential shapes. Previously inlined separately in the AI page and the
// reviews page, where they could drift; every Cloudflare form now validates the
// same way.
var (
	hexPattern32        = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	pagesProjectPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)
	d1IDPattern         = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)
)

func (a *AdminServer) deployment(w http.ResponseWriter, r *http.Request, session adminSession) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := a.config.Get()
	cloudflare := a.cloudflareClient()

	var b strings.Builder
	b.WriteString(`<section class="hero"><div><p class="eyebrow">自部署 / fork</p><h1>部署配置</h1><p>这一页决定「这套系统部署在谁的域名下、用谁的账号」。全部改完即可独立运行，不需要再去源码里替换任何常量。</p></div></section>`)

	b.WriteString(a.deploymentChecklist(cfg, cloudflare))
	b.WriteString(a.siteIdentityCard(session, cfg))
	b.WriteString(frontendWiringCard(cfg))
	b.WriteString(a.cloudflareCard(session, cloudflare))
	b.WriteString(a.credentialsCard(session))
	b.WriteString(a.adminAccessCard(session))

	a.render(w, "部署配置", b.String(), &session)
}

// deploymentChecklist is the first thing a forker should see: what is still
// unset, in the order it matters. Everything green means the deployment no
// longer depends on the upstream author's infrastructure.
func (a *AdminServer) deploymentChecklist(cfg RuntimeConfig, cloudflare *CloudflarePagesClient) string {
	items := []struct {
		Label string
		OK    bool
		Hint  string
	}{
		{"站点地址（前端域名）", cfg.SiteOrigin != "", "决定 CORS 放行谁，也决定下面生成的前端配置"},
		{"后端对外地址", cfg.BackendPublicURL != "", "前端请求实时人数 / 学号课表的根地址"},
		{"教务只读账号", a.envValue("XK_USERNAME") != "", "没有它就没有实时人数和学号课表"},
		{"学号接口共享密钥", a.envValue("LIVE_SECRET") != "", "Pages Function 调 /live/student-record 的凭证"},
		{"Cloudflare 账号与 Token", cloudflare.accountID != "" && cloudflare.apiToken != "", "评价库与 AI 配置都要用"},
		{"Cloudflare Pages 项目", cloudflare.project != "", "AI 配置页要写它的环境变量"},
		{"Cloudflare D1 数据库", cloudflare.d1DatabaseID != "", "评价、举报、人机验证开关都存在这里"},
		{"管理面板密码", a.envValue("ADMIN_PASSWORD") != "" && a.envValue("ADMIN_PASSWORD") != "changeme", "默认值 changeme 必须改掉"},
	}
	done := 0
	var rows strings.Builder
	for _, item := range items {
		badge := `<span class="badge err">待配置</span>`
		if item.OK {
			badge = `<span class="badge">已配置</span>`
			done++
		}
		rows.WriteString(`<div><dt>` + template.HTMLEscapeString(item.Label) + `</dt><dd>` + badge +
			`<p class="hint">` + template.HTMLEscapeString(item.Hint) + `</p></dd></div>`)
	}
	summary := fmt.Sprintf(`<span class="badge">%d / %d 项已配置</span>`, done, len(items))
	if done < len(items) {
		summary = fmt.Sprintf(`<span class="badge warn">%d / %d 项已配置，还差 %d 项</span>`, done, len(items), len(items)-done)
	}
	return `<section class="card"><h2>自部署检查清单</h2><p>` + summary + `</p><dl class="facts">` + rows.String() + `</dl></section>`
}

func (a *AdminServer) siteIdentityCard(session adminSession, cfg RuntimeConfig) string {
	var b strings.Builder
	b.WriteString(`<section class="card"><h2>1. 站点身份</h2>`)
	b.WriteString(`<p class="hint">只填到域名，不要带路径。保存后<b>站点地址会自动加入 CORS 白名单</b>（原有条目保留，可在<a href="/advanced">高级设置</a>里增删）。这两个值只影响浏览器能否跨域读到本后端，以及下面那张「前端对接清单」生成什么。</p>`)
	b.WriteString(`<form method="post" action="/action/save-site" class="stack">` + csrf(session))
	b.WriteString(`<div class="field"><label>站点地址 <code>siteOrigin</code></label><input name="siteOrigin" maxlength="200" autocomplete="off" placeholder="https://xk.example.edu" value="` +
		template.HTMLEscapeString(cfg.SiteOrigin) + `"><p class="hint">用户在浏览器里打开的那个地址（Cloudflare Pages 的自定义域名或 *.pages.dev）。</p></div>`)
	b.WriteString(`<div class="field"><label>后端对外地址 <code>backendPublicUrl</code></label><input name="backendPublicUrl" maxlength="200" autocomplete="off" placeholder="https://getxk.example.edu" value="` +
		template.HTMLEscapeString(cfg.BackendPublicURL) + `"><p class="hint">反向代理指向本机 ` +
		template.HTMLEscapeString(a.env.PublicAddr) + ` 的那个公网地址。留空表示不对外提供实时人数。</p></div>`)
	b.WriteString(`<button class="button primary" type="submit">保存站点身份（立即生效）</button></form></section>`)
	return b.String()
}

// frontendWiringCard prints the exact values the Cloudflare Pages side needs.
// These used to live as hardcoded fallbacks in the frontend source, so a fork
// had to know to go find them; now they are derived from what was just saved.
func frontendWiringCard(cfg RuntimeConfig) string {
	backend := cfg.BackendPublicURL
	if backend == "" {
		return `<section class="card"><h2>2. 前端对接清单</h2><p class="hint">填好上面的「后端对外地址」后，这里会生成前端那侧要照抄的配置。</p></section>`
	}
	host := backend
	if parsed, err := url.Parse(backend); err == nil && parsed.Host != "" {
		host = parsed.Host
	}

	envBlock := "# 仓库根目录 .env（提交进 fork；Pages 控制台里同名变量优先级更高）\n" +
		"VITE_KKAP_API_URL=" + backend + "/api/enrollments\n" +
		"VITE_BACKEND_CONFIG_URL=" + backend + "/api/config\n"
	tomlBlock := "# wrangler.toml [vars]\n" +
		"LIVE_URL = \"" + backend + "/live/student-record\"\n"
	caddyBlock := host + " {\n" +
		"\tencode zstd gzip\n" +
		"\thandle_path /cap/* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n" +
		"\thandle_path /live/* {\n\t\treverse_proxy " + DefaultLiveAddr + "\n\t}\n" +
		"\thandle {\n\t\treverse_proxy " + DefaultPublicAddr + "\n\t}\n" +
		"\theader {\n\t\tX-Frame-Options DENY\n\t\tReferrer-Policy no-referrer\n\t}\n}\n"

	var b strings.Builder
	b.WriteString(`<section class="card"><h2>2. 前端对接清单</h2><p class="hint">下面三段按当前配置生成，照抄即可。管理面板改不到 Cloudflare Pages 的构建输入，所以这一步仍要在你自己的仓库/控制台里做一次。</p>`)
	for _, item := range [][2]string{
		{"前端环境变量", envBlock},
		{"wrangler.toml", tomlBlock},
		{"反向代理（Caddy）", caddyBlock},
	} {
		b.WriteString(`<h3>` + item[0] + `</h3><pre class="log-view">` + template.HTMLEscapeString(item[1]) + `</pre>`)
	}
	b.WriteString(`<p class="hint">另外两处必须在 fork 的仓库里改：<code>wrangler.toml</code> 的 <code>name</code>（Pages 项目名）与 <code>[[d1_databases]].database_id</code>（你自己的 D1 库 ID）。它们是构建期绑定，后端改不了。</p></section>`)
	return b.String()
}

func (a *AdminServer) cloudflareCard(session adminSession, cloudflare *CloudflarePagesClient) string {
	tokenLabel := "API Token"
	tokenRequired := " required"
	if cloudflare.apiToken != "" {
		tokenLabel += "（留空 = 沿用现有 Token）"
		tokenRequired = ""
	}
	var b strings.Builder
	b.WriteString(`<section class="card"><h2>3. Cloudflare 账号</h2>`)
	b.WriteString(`<p class="hint">评价库（D1）和 AI 配置（Pages 环境变量）共用同一个 Token，需要同时具备 <b>Account / D1 / Edit</b> 与 <b>Account / Cloudflare Pages / Edit</b> 两种权限。保存前会真的调一次 API 验证，通过才写入 backend.env（0600）。</p>`)
	b.WriteString(`<form method="post" action="/action/save-cloudflare-all" class="stack">` + csrf(session))
	b.WriteString(`<div class="field"><label>Account ID</label><input name="cfAccountID" minlength="32" maxlength="32" autocomplete="off" value="` + template.HTMLEscapeString(cloudflare.accountID) + `" required></div>`)
	b.WriteString(`<div class="field"><label>` + tokenLabel + `</label><input type="password" name="cfAPIToken" maxlength="512" autocomplete="new-password"` + tokenRequired + `></div>`)
	b.WriteString(`<div class="field"><label>Pages 项目名 <code>CF_PAGES_PROJECT</code></label><input name="cfPagesProject" maxlength="63" autocomplete="off" placeholder="my-elective-plus" value="` + template.HTMLEscapeString(cloudflare.project) + `" required></div>`)
	b.WriteString(`<div class="field"><label>D1 数据库 ID <code>CF_D1_DATABASE_ID</code></label><input name="cfD1DatabaseID" minlength="8" maxlength="64" autocomplete="off" value="` + template.HTMLEscapeString(cloudflare.d1DatabaseID) + `" required><p class="hint">Cloudflare Dashboard → D1 → 你的库详情页可见，必须与 <code>wrangler.toml</code> 里的 <code>database_id</code> 一致。</p></div>`)
	b.WriteString(`<button class="button primary" type="submit">验证并保存（立即生效）</button></form></section>`)
	return b.String()
}

func (a *AdminServer) credentialsCard(session adminSession) string {
	var b strings.Builder
	b.WriteString(`<section class="card"><h2>4. 教务账号与服务密钥</h2>`)
	b.WriteString(`<p class="hint">写入 backend.env（0600），页面永不回显。抓取实时人数、学号课表的后台任务在启动时读取这些值，<b>改完需要重启服务</b>才会生效。</p>`)
	b.WriteString(`<form method="post" action="/action/save-credentials" class="stack">` + csrf(session))
	b.WriteString(`<div class="field"><label>教务账号 <code>XK_USERNAME</code>（` + configured(a.envValue("XK_USERNAME")) + `）</label><input name="xkUsername" maxlength="64" autocomplete="off" value="` + template.HTMLEscapeString(a.envValue("XK_USERNAME")) + `"><p class="hint">只读查询用的普通账号，不要用有选课权限的账号。</p></div>`)
	b.WriteString(`<div class="field"><label>教务密码 <code>XK_PASSWORD</code>（` + configured(a.envValue("XK_PASSWORD")) + `，留空 = 不修改）</label><input type="password" name="xkPassword" maxlength="128" autocomplete="new-password"></div>`)
	b.WriteString(`<div class="field"><label>学号接口共享密钥 <code>LIVE_SECRET</code>（` + configured(a.envValue("LIVE_SECRET")) + `，留空 = 不修改）</label><input type="password" name="liveSecret" maxlength="128" autocomplete="new-password"><p class="hint">与 Cloudflare Pages 的 <code>LIVE_SECRET</code>（<code>wrangler pages secret put LIVE_SECRET</code>）必须一致。勾选下面一项可自动生成一个强随机值，生成结果只显示这一次。</p></div>`)
	b.WriteString(`<label class="inline"><input type="checkbox" name="generateLiveSecret">自动生成新的 LIVE_SECRET（忽略上面填的值）</label>`)
	b.WriteString(`<button class="button primary" type="submit">保存凭据</button></form></section>`)
	return b.String()
}

func (a *AdminServer) adminAccessCard(session adminSession) string {
	var b strings.Builder
	b.WriteString(`<section class="card"><h2>5. 面板自身</h2>`)
	b.WriteString(`<dl class="facts"><div><dt>面板监听</dt><dd>` + template.HTMLEscapeString(a.env.AdminAddr) + `</dd></div>` +
		`<div><dt>公开 API 监听</dt><dd>` + template.HTMLEscapeString(a.env.PublicAddr) + `</dd></div>` +
		`<div><dt>学号服务监听</dt><dd>` + template.HTMLEscapeString(a.env.LiveAddr) + `</dd></div>` +
		`<div><dt>仓库目录</dt><dd>` + template.HTMLEscapeString(a.env.RepoDir) + `</dd></div></dl>`)
	b.WriteString(`<p class="hint">三个监听地址都在 backend.env 里（<code>ADMIN_ADDR</code> / <code>PUBLIC_ADDR</code> / <code>LIVE_ADDR</code>）。默认只绑定回环地址，面板经 SSH 隧道访问——<b>不要把面板绑到 0.0.0.0</b>，它只有一道口令。</p>`)

	b.WriteString(`<h3>修改管理密码</h3>`)
	b.WriteString(`<form method="post" action="/action/save-admin-password" class="stack">` + csrf(session))
	b.WriteString(`<div class="field"><label>当前密码</label><input type="password" name="currentPassword" autocomplete="current-password" required></div>`)
	b.WriteString(`<div class="field"><label>新密码（至少 12 位）</label><input type="password" name="newPassword" minlength="12" maxlength="128" autocomplete="new-password" required></div>`)
	b.WriteString(`<div class="field"><label>再输一次</label><input type="password" name="confirmPassword" minlength="12" maxlength="128" autocomplete="new-password" required></div>`)
	b.WriteString(`<p class="hint">保存后立即生效，并且会踢掉所有已登录会话（包括当前这个），需要用新密码重新登录。</p>`)
	b.WriteString(`<button class="button primary" type="submit">修改密码</button></form>`)

	b.WriteString(`<h3>重启后端</h3><p class="hint">修改教务账号、密钥或监听地址后需要重启。重启期间面板会短暂无法访问，约几秒后刷新即可。</p>`)
	b.WriteString(`<form method="post" action="/action/restart-backend" onsubmit="return confirm('确定重启后端服务？面板会短暂断开。')">` + csrf(session) +
		`<button class="button" type="submit">重启 ` + deploymentRestartUnit + `</button></form>`)
	b.WriteString(`</section>`)
	return b.String()
}

// envValue reads one key straight from backend.env. The panel must show what is
// actually persisted, not the values this process was started with — otherwise
// a credential saved a minute ago would still read "未配置" until a restart.
func (a *AdminServer) envValue(key string) string {
	raw, err := os.ReadFile(a.env.EnvFilePath)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		if value, ok := strings.CutPrefix(line, key+"="); ok {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (a *AdminServer) saveSiteIdentity(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	siteOrigin := NormalizeDeploymentOrigin(r.Form.Get("siteOrigin"))
	backendURL := NormalizeDeploymentOrigin(r.Form.Get("backendPublicUrl"))
	for label, value := range map[string]string{"站点地址": siteOrigin, "后端对外地址": backendURL} {
		if value == "" {
			continue
		}
		if err := validateDeploymentOrigin(value); err != nil {
			a.result(w, "保存失败", label+err.Error(), false, &session)
			return
		}
	}

	cfg := a.config.Get()
	before := map[string]any{"siteOrigin": cfg.SiteOrigin, "backendPublicUrl": cfg.BackendPublicURL}
	cfg.SiteOrigin = siteOrigin
	cfg.BackendPublicURL = backendURL
	// 站点地址就是浏览器发来的 Origin，自动并进白名单，省掉「填了域名还是跨域失败」
	// 这个每个自部署者都会踩一次的坑。已有条目一律保留。
	added := false
	if siteOrigin != "" && !contains(cfg.AllowedOrigins, siteOrigin) {
		cfg.AllowedOrigins = append(cfg.AllowedOrigins, siteOrigin)
		added = true
	}
	if err := a.config.Save(cfg); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}

	detail := "站点地址 " + emptyDash(siteOrigin) + "；后端对外地址 " + emptyDash(backendURL) + "。"
	if added {
		detail += "已自动把站点地址加入 CORS 白名单。"
	}
	a.audit(r.Context(), r, auditEntry{
		Action: auditDeployment, Target: "site-identity", Detail: detail,
		Before: before, After: map[string]any{"siteOrigin": siteOrigin, "backendPublicUrl": backendURL},
	})
	a.result(w, "站点身份已保存", detail+"回到部署配置页可以看到生成好的前端对接清单。", true, &session)
}

// saveCloudflareAll is the single entry point for all four Cloudflare values.
// They were previously split across the AI page (account/token/project) and the
// reviews page (account/token/database), which meant saving one could silently
// invalidate the other. Both permissions are verified before anything is written.
func (a *AdminServer) saveCloudflareAll(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	accountID := strings.TrimSpace(r.Form.Get("cfAccountID"))
	project := strings.TrimSpace(r.Form.Get("cfPagesProject"))
	dbID := strings.TrimSpace(r.Form.Get("cfD1DatabaseID"))
	token := strings.TrimSpace(r.Form.Get("cfAPIToken"))

	if !hexPattern32.MatchString(accountID) {
		a.result(w, "保存失败", "Account ID 应为 32 位十六进制字符串", false, &session)
		return
	}
	if !pagesProjectPattern.MatchString(project) {
		a.result(w, "保存失败", "Pages 项目名格式不合法（小写字母、数字、连字符）", false, &session)
		return
	}
	if !d1IDPattern.MatchString(dbID) {
		a.result(w, "保存失败", "D1 数据库 ID 格式不合法（应为 Dashboard 里的 UUID）", false, &session)
		return
	}
	current := a.cloudflareClient()
	if token == "" {
		token = current.apiToken
	}
	if len(token) < 20 || len(token) > 512 || strings.ContainsAny(token, "\r\n") {
		a.result(w, "保存失败", "API Token 格式不合法", false, &session)
		return
	}

	nextEnv := a.env
	nextEnv.CFAccountID, nextEnv.CFAPIToken, nextEnv.CFPagesProject, nextEnv.CFD1DatabaseID = accountID, token, project, dbID
	client := NewCloudflarePagesClient(nextEnv)

	ctx, cancel := context.WithTimeout(r.Context(), D1RequestTimeout)
	defer cancel()
	if _, err := client.GetProject(ctx); err != nil {
		a.result(w, "保存失败", "Pages 权限未通过验证："+err.Error()+"。请确认 Token 含 Account / Cloudflare Pages / Edit，且项目名正确。", false, &session)
		return
	}
	if _, _, err := client.D1Query(ctx, "SELECT 1 AS ok", nil); err != nil {
		a.result(w, "保存失败", "D1 权限未通过验证："+err.Error()+"。请确认同一个 Token 还含 Account / D1 / Edit，且库 ID 正确。", false, &session)
		return
	}

	if err := updateEnvironmentFile(a.env.EnvFilePath, map[string]string{
		"CF_ACCOUNT_ID": accountID, "CF_API_TOKEN": token,
		"CF_PAGES_PROJECT": project, "CF_D1_DATABASE_ID": dbID,
	}); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.setCloudflareClient(client)
	a.audit(ctx, r, auditEntry{
		Action: auditDeployment, Target: "cloudflare",
		Detail: "更新 Cloudflare 连接：account " + accountID + "，项目 " + project + "，D1 " + dbID + "。",
		After:  map[string]any{"accountId": accountID, "project": project, "databaseId": dbID, "tokenUpdated": strings.TrimSpace(r.Form.Get("cfAPIToken")) != ""},
	})
	a.result(w, "Cloudflare 已连接", "Pages 与 D1 两种权限都已验证通过，凭据已保存并立即生效。", true, &session)
}

func (a *AdminServer) saveCredentials(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	updates := map[string]string{}
	changed := []string{}

	username := strings.TrimSpace(r.Form.Get("xkUsername"))
	if username != a.envValue("XK_USERNAME") {
		if strings.ContainsAny(username, " \t\r\n") || len(username) > 64 {
			a.result(w, "保存失败", "教务账号须单行且不超过 64 字符", false, &session)
			return
		}
		updates["XK_USERNAME"] = username
		changed = append(changed, "教务账号")
	}
	if password := r.Form.Get("xkPassword"); password != "" {
		if strings.ContainsAny(password, "\r\n") || len(password) > 128 {
			a.result(w, "保存失败", "教务密码须单行且不超过 128 字符", false, &session)
			return
		}
		updates["XK_PASSWORD"] = password
		changed = append(changed, "教务密码")
	}

	generated := ""
	if r.Form.Get("generateLiveSecret") == "on" {
		generated = randomToken(24)
		updates["LIVE_SECRET"] = generated
		changed = append(changed, "学号接口密钥（新生成）")
	} else if secret := strings.TrimSpace(r.Form.Get("liveSecret")); secret != "" {
		if strings.ContainsAny(secret, " \t\r\n") || len(secret) > 128 {
			a.result(w, "保存失败", "学号接口密钥须单行且不超过 128 字符", false, &session)
			return
		}
		updates["LIVE_SECRET"] = secret
		changed = append(changed, "学号接口密钥")
	}

	if len(updates) == 0 {
		a.result(w, "没有改动", "没有检测到需要保存的变更。", false, &session)
		return
	}
	if err := updateEnvironmentFile(a.env.EnvFilePath, updates); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.audit(r.Context(), r, auditEntry{
		Action: auditDeployment, Target: "credentials",
		Detail: "更新了：" + strings.Join(changed, "、") + "（值不入日志）。需重启后端生效。",
	})

	message := "已写入 backend.env：" + strings.Join(changed, "、") + "。抓取任务在启动时读取这些值，请用下方「重启后端」按钮重启后生效。"
	if generated != "" {
		message += "  新的 LIVE_SECRET（只显示这一次，请立刻同步到 Cloudflare Pages 的同名 secret）：" + generated
	}
	a.result(w, "凭据已保存", message, true, &session)
}

func (a *AdminServer) saveAdminPassword(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	currentInput := r.Form.Get("currentPassword")
	next := r.Form.Get("newPassword")
	confirm := r.Form.Get("confirmPassword")

	stored := a.currentAdminPassword()
	if stored == "" || subtle.ConstantTimeCompare([]byte(currentInput), []byte(stored)) != 1 {
		a.result(w, "修改失败", "当前密码不正确", false, &session)
		return
	}
	if next != confirm {
		a.result(w, "修改失败", "两次输入的新密码不一致", false, &session)
		return
	}
	if len([]rune(next)) < 12 || len(next) > 128 || strings.ContainsAny(next, "\r\n") {
		a.result(w, "修改失败", "新密码须为 12–128 位且不含换行", false, &session)
		return
	}
	if next == stored {
		a.result(w, "修改失败", "新密码与当前密码相同", false, &session)
		return
	}
	if err := updateEnvironmentFile(a.env.EnvFilePath, map[string]string{"ADMIN_PASSWORD": next}); err != nil {
		a.result(w, "修改失败", err.Error(), false, &session)
		return
	}
	// 立刻生效并清空所有会话：密码改了却还能用旧会话操作，等于没改。
	a.mu.Lock()
	a.adminPassword = next
	a.sessions = map[string]adminSession{}
	a.mu.Unlock()

	a.audit(r.Context(), r, auditEntry{
		Action: auditDeployment, Target: "admin-password",
		Detail: "修改了管理面板密码，并清空了全部登录会话（密码值不入日志）。",
	})
	a.renderStatus(w, "密码已修改", layoutHTML("密码已修改",
		`<section class="card result success"><h1>密码已修改</h1><p>新密码已生效，所有登录会话已失效。请用新密码重新登录。</p><p><a class="button primary" href="/login">去登录</a></p></section>`, nil), http.StatusOK)
}

// restartBackend restarts this very process. The command is detached and
// delayed so this response is fully written before systemd stops us; otherwise
// the operator sees a connection reset and can't tell success from failure.
func (a *AdminServer) restartBackend(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	if runtime.GOOS == "windows" {
		a.result(w, "重启失败", "systemctl 仅在 VPS Linux 环境可用", false, &session)
		return
	}
	cmd := exec.Command("sh", "-c", "sleep 2; systemctl --user restart "+deploymentRestartUnit)
	if err := cmd.Start(); err != nil {
		a.result(w, "重启失败", err.Error(), false, &session)
		return
	}
	go func() { _ = cmd.Wait() }()
	a.audit(r.Context(), r, auditEntry{Action: auditDeployment, Target: "restart", Detail: "从面板触发了后端重启。"})
	a.result(w, "正在重启", "已安排在 2 秒后重启 "+deploymentRestartUnit+"。等几秒后刷新页面即可；若长时间打不开，请用 SSH 执行 systemctl --user status "+deploymentRestartUnit+" 查看原因。", true, &session)
}

// currentAdminPassword returns the live password, which may have been changed
// after start-up.
func (a *AdminServer) currentAdminPassword() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.adminPassword
}
