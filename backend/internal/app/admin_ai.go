package app

import (
	"context"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultAIInstruction = `你是江西师范大学学生的选课参谋。请结合培养方案缺口、学生偏好、上课时间、教师评分与班级余量，给出数量克制、理由具体、可以直接执行的下学期选课建议。

专业限选只在仍有硬性学分缺口时补足，不要超额囤选。专业任选和任意选修都属于普通选修，二者优先级完全相同；不得因为课程位于培养方案内就额外偏爱专业任选。`

type aiAdminSettings struct {
	BaseURL      string
	Model        string
	SystemPrompt string
	Temperature  string
	MaxTokens    int
	Timeout      int
	VoterDaily   int
	SiteCalls    int
	SiteTokens   int
	APIKey       string
}

// cloudflareConnectCard is the shared Pages connection form. Used when no
// credentials exist yet, and as a recovery path when the stored token stops
// working (expired / replaced by a D1-only token).
func (a *AdminServer) cloudflareConnectCard(session adminSession, title, intro string) string {
	cloudflare := a.cloudflareClient()
	return `<section class="card result error"><h2>` + template.HTMLEscapeString(title) + `</h2><p>` + intro + `</p><p class="hint">API Token 需要 Account / Cloudflare Pages / Edit 权限；若同时使用评价管理，请在同一个 Token 上再勾选 Account / D1 / Edit。Token 只写入 VPS，不会显示在页面、结果或日志中。</p>` +
		`<form method="post" action="/action/save-cloudflare" class="stack">` + csrf(session) +
		`<div class="field"><label>Cloudflare Account ID</label><input name="cfAccountID" minlength="32" maxlength="32" autocomplete="off" value="` + template.HTMLEscapeString(cloudflare.accountID) + `" required></div>` +
		`<div class="field"><label>Pages 项目名</label><input name="cfPagesProject" value="` + template.HTMLEscapeString(cloudflare.ProjectName()) + `" placeholder="jxnu-elective-plus" maxlength="64" required></div>` +
		`<div class="field"><label>Cloudflare API Token</label><input type="password" name="cfAPIToken" minlength="20" maxlength="512" autocomplete="new-password" required></div>` +
		`<button class="button primary" type="submit">验证并保存 Cloudflare 连接</button></form></section>`
}

func (a *AdminServer) aiSettings(w http.ResponseWriter, r *http.Request, session adminSession) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.Ready() {
		body := `<section class="hero"><div><p class="eyebrow">AI 帮我选</p><h1>模型与预算配置</h1></div></section>` +
			a.cloudflareConnectCard(session, "先连接 Cloudflare Pages", "当前 VPS 没有可用的 Pages 管理凭据。只需在这里初始化一次；验证通过后会以 0600 权限写入 backend.env，并立即解锁下方完整 AI 配置。")
		a.render(w, "AI 配置", body, &session)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	project, err := cloudflare.GetProject(ctx)
	if err != nil {
		// 凭据存在但打不通（403 = token 失效或被换成了只有 D1 权限的 token）——
		// 直接给出重连表单，现场换一个带 Pages 权限的 Token。
		a.render(w, "AI 配置", `<section class="hero"><div><p class="eyebrow">AI 帮我选</p><h1>模型与预算配置</h1></div></section>`+
			a.cloudflareConnectCard(session, "读取 Cloudflare Pages 失败",
				template.HTMLEscapeString(err.Error())+`<br>常见原因：API Token 过期，或最近在评价管理里保存了一个只有 D1 权限的 Token（两处共用同一个 <code>CF_API_TOKEN</code>）。请填入同时具有 Pages 与 D1 权限的 Token。`), &session)
		return
	}

	vars := project.DeploymentConfigs.Production.EnvVars
	value := func(key, fallback string) string {
		if item, ok := vars[key]; ok && item.Type != "secret_text" && strings.TrimSpace(item.Value) != "" {
			return item.Value
		}
		return fallback
	}
	promptItem, promptStored := vars["AI_SYSTEM_PROMPT"]
	promptStored = promptStored && strings.TrimSpace(promptItem.Value) != ""
	apiKeyConfigured := vars["AI_API_KEY"].Type == "secret_text"
	latest := "尚无 production 部署记录"
	if dep := project.LatestDeployment; dep != nil {
		state := strings.Trim(strings.TrimSpace(dep.LatestStage.Name+" / "+dep.LatestStage.Status), " /")
		latest = emptyDash(state)
		if dep.CreatedOn != "" {
			latest += " · " + dep.CreatedOn
		}
	}

	promptNote := `<span class="badge">已由 Cloudflare 环境变量托管</span>`
	if !promptStored {
		promptNote = `<span class="badge warn">当前未单独设置；表单已填入推荐默认值</span>`
	}
	body := fmt.Sprintf(`<section class="hero"><div><p class="eyebrow">AI 帮我选</p><h1>模型、提示词与预算</h1><p>保存会修改 Cloudflare Pages production 环境变量，并立即创建一次 production 部署。</p></div></section>
<div class="grid three"><section class="card"><h2>Pages 项目</h2><p class="big">%s</p><p class="hint">%s</p></section><section class="card"><h2>模型密钥</h2><p class="big">%s</p><p class="hint">页面永不回显现有 secret</p></section><section class="card"><h2>最近部署</h2><p>%s</p></section></div>
<form method="post" action="/action/save-ai" class="stack">%s
<section class="card"><h2>1. 服务商连接</h2>
<div class="field"><label>OpenAI-compatible 服务商 URL <code>AI_BASE_URL</code></label><input type="url" name="aiBaseURL" value="%s" placeholder="https://api.deepseek.com/v1" required><p class="hint">填写 API 根地址，例如末尾到 /v1；不要填写 /chat/completions。生产环境仅接受 HTTPS。</p></div>
<div class="field"><label>模型名称 <code>AI_MODEL</code></label><input name="aiModel" value="%s" placeholder="deepseek-chat" maxlength="120" required></div>
<div class="field"><label>API Key <code>AI_API_KEY</code></label><input type="password" name="aiAPIKey" value="" maxlength="4096" autocomplete="new-password" placeholder="留空表示保留现有 secret"><p class="hint">只写入 secret_text；保存成功后不会再显示。</p></div></section>
<section class="card"><h2>2. 模型系统提示词</h2><p>%s</p><textarea class="prompt" name="aiSystemPrompt" rows="13" maxlength="12000" required>%s</textarea><p class="hint">这是可编辑的业务系统提示词。接口还会固定追加候选白名单、时段冲突、专业限选缺口、专业任选=任意选修、JSON 输出和防注入规则；这些安全与业务底线不能在面板中关闭。</p></section>
<section class="card"><h2>3. 生成参数</h2><div class="grid three">%s%s%s</div><p class="hint">温度越低越稳定；最大输出只影响回答长度；超时应低于 Pages Function 的整体执行上限。</p></section>
<section class="card"><h2>4. 每日配额与熔断</h2><div class="grid three">%s%s%s</div><p class="hint">按 UTC 自然日统计。用户次数按本地 voter UUID 计数；全站 token 包含输入与输出，失败调用已消耗的 token 也会记账。</p></section>
<div class="actions"><button class="button primary" type="submit">保存配置并部署 production</button></div></form>
<section class="card"><h2>只重新部署</h2><p class="hint">环境变量已经正确、只是上次部署失败时使用。不会修改任何配置。</p><form method="post" action="/action/redeploy-ai">%s<button class="button" type="submit">重新部署 production</button></form></section>`,
		template.HTMLEscapeString(cloudflare.ProjectName()), template.HTMLEscapeString(project.Name), map[bool]string{true: "已配置", false: "未配置"}[apiKeyConfigured], template.HTMLEscapeString(latest), csrf(session),
		template.HTMLEscapeString(value("AI_BASE_URL", "https://api.deepseek.com/v1")), template.HTMLEscapeString(value("AI_MODEL", "deepseek-chat")), promptNote, template.HTMLEscapeString(value("AI_SYSTEM_PROMPT", defaultAIInstruction)),
		decimalField("aiTemperature", "温度", value("AI_TEMPERATURE", "0.3"), "0", "2", "0.1"), numberInput("aiMaxTokens", "最大输出 token", value("AI_MAX_OUTPUT_TOKENS", "1500"), 256, 8192), numberInput("aiTimeout", "上游超时（秒）", value("AI_UPSTREAM_TIMEOUT_SECONDS", "60"), 10, 120),
		numberInput("aiVoterDaily", "单用户每日次数", value("AI_VOTER_DAILY", "10"), 1, 1000), numberInput("aiSiteCalls", "全站每日调用", value("AI_SITE_DAILY_CALLS", "300"), 1, 1000000), numberInput("aiSiteTokens", "全站每日 token", value("AI_SITE_DAILY_TOKENS", "2000000"), 1000, 1000000000), csrf(session))
	a.render(w, "AI 配置", body, &session)
}

func (a *AdminServer) saveAI(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.Ready() {
		a.result(w, "保存失败", "Cloudflare Pages API 凭据未配置", false, &session)
		return
	}
	settings, err := parseAIAdminSettings(r)
	if err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	updates := map[string]CloudflareEnvVar{
		"AI_BASE_URL":                 {Type: "plain_text", Value: settings.BaseURL},
		"AI_MODEL":                    {Type: "plain_text", Value: settings.Model},
		"AI_SYSTEM_PROMPT":            {Type: "plain_text", Value: settings.SystemPrompt},
		"AI_TEMPERATURE":              {Type: "plain_text", Value: settings.Temperature},
		"AI_MAX_OUTPUT_TOKENS":        {Type: "plain_text", Value: strconv.Itoa(settings.MaxTokens)},
		"AI_UPSTREAM_TIMEOUT_SECONDS": {Type: "plain_text", Value: strconv.Itoa(settings.Timeout)},
		"AI_VOTER_DAILY":              {Type: "plain_text", Value: strconv.Itoa(settings.VoterDaily)},
		"AI_SITE_DAILY_CALLS":         {Type: "plain_text", Value: strconv.Itoa(settings.SiteCalls)},
		"AI_SITE_DAILY_TOKENS":        {Type: "plain_text", Value: strconv.Itoa(settings.SiteTokens)},
	}
	if settings.APIKey != "" {
		updates["AI_API_KEY"] = CloudflareEnvVar{Type: "secret_text", Value: settings.APIKey}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	if err := cloudflare.PatchProductionEnv(ctx, updates); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	deployment, err := cloudflare.CreateProductionDeployment(ctx)
	if err != nil {
		a.result(w, "配置已保存，但部署失败", "Cloudflare 已接收环境变量；请返回 AI 配置页重试部署。"+err.Error(), false, &session)
		return
	}
	a.result(w, "AI 配置已保存", "已创建 production 部署 "+emptyDash(deployment.ID)+"；Cloudflare 构建完成后新配置生效。", true, &session)
}

func (a *AdminServer) redeployAI(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.Ready() {
		a.result(w, "部署失败", "Cloudflare Pages API 凭据未配置", false, &session)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 75*time.Second)
	defer cancel()
	deployment, err := cloudflare.CreateProductionDeployment(ctx)
	if err != nil {
		a.result(w, "部署失败", err.Error(), false, &session)
		return
	}
	a.result(w, "已触发 production 部署", "部署编号："+emptyDash(deployment.ID), true, &session)
}

func (a *AdminServer) saveCloudflareConnection(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	accountID := strings.TrimSpace(r.Form.Get("cfAccountID"))
	project := strings.TrimSpace(r.Form.Get("cfPagesProject"))
	token := strings.TrimSpace(r.Form.Get("cfAPIToken"))
	if !hexPattern32.MatchString(accountID) {
		a.result(w, "连接失败", "Cloudflare Account ID 应为 32 位十六进制字符串", false, &session)
		return
	}
	if !pagesProjectPattern.MatchString(project) {
		a.result(w, "连接失败", "Pages 项目名格式不合法", false, &session)
		return
	}
	if len(token) < 20 || len(token) > 512 || strings.ContainsAny(token, "\r\n") {
		a.result(w, "连接失败", "Cloudflare API Token 格式不合法", false, &session)
		return
	}
	nextEnv := a.env
	nextEnv.CFAccountID = accountID
	nextEnv.CFAPIToken = token
	nextEnv.CFPagesProject = project
	client := NewCloudflarePagesClient(nextEnv)
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, err := client.GetProject(ctx); err != nil {
		a.result(w, "连接失败", "Cloudflare 未通过验证："+err.Error(), false, &session)
		return
	}
	if err := updateEnvironmentFile(a.env.EnvFilePath, map[string]string{
		"CF_ACCOUNT_ID":    accountID,
		"CF_API_TOKEN":     token,
		"CF_PAGES_PROJECT": project,
	}); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.setCloudflareClient(client)
	a.result(w, "Cloudflare 已连接", "凭据已安全保存。返回 AI 配置页即可设置服务商、模型、提示词和预算。", true, &session)
}

func updateEnvironmentFile(path string, updates map[string]string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("backend.env 路径未配置")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取 backend.env: %w", err)
	}
	for key, value := range updates {
		if strings.ContainsAny(key+value, "\r\n") {
			return fmt.Errorf("环境变量 %s 含非法换行", key)
		}
	}
	remaining := make(map[string]string, len(updates))
	for key, value := range updates {
		remaining[key] = value
	}
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	for index, line := range lines {
		for key, value := range remaining {
			if strings.HasPrefix(line, key+"=") {
				lines[index] = key + "=" + value
				delete(remaining, key)
				break
			}
		}
	}
	for key, value := range remaining {
		lines = append(lines, key+"="+value)
	}
	next := strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n"
	if err := atomicWrite(path, []byte(next), 0o600); err != nil {
		return fmt.Errorf("写入 backend.env: %w", err)
	}
	return nil
}

func parseAIAdminSettings(r *http.Request) (aiAdminSettings, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(r.Form.Get("aiBaseURL")), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return aiAdminSettings{}, fmt.Errorf("服务商 URL 必须是无查询参数的 HTTPS 根地址")
	}
	if strings.HasSuffix(strings.ToLower(parsed.Path), "/chat/completions") {
		return aiAdminSettings{}, fmt.Errorf("服务商 URL 请填写 API 根地址，不要包含 /chat/completions")
	}
	model := strings.TrimSpace(r.Form.Get("aiModel"))
	if model == "" || len(model) > 120 || strings.ContainsAny(model, "\r\n") {
		return aiAdminSettings{}, fmt.Errorf("模型名称不能为空且不能超过 120 字符")
	}
	prompt := strings.TrimSpace(r.Form.Get("aiSystemPrompt"))
	if len([]rune(prompt)) < 20 || len(prompt) > 12000 {
		return aiAdminSettings{}, fmt.Errorf("系统提示词须为 20–12000 字节")
	}
	temperature, err := strconv.ParseFloat(strings.TrimSpace(r.Form.Get("aiTemperature")), 64)
	if err != nil || temperature < 0 || temperature > 2 {
		return aiAdminSettings{}, fmt.Errorf("温度须为 0–2 的数字")
	}
	maxTokens, err := parseBoundedFormInt(r, "aiMaxTokens", 256, 8192)
	if err != nil {
		return aiAdminSettings{}, err
	}
	timeout, err := parseBoundedFormInt(r, "aiTimeout", 10, 120)
	if err != nil {
		return aiAdminSettings{}, err
	}
	voterDaily, err := parseBoundedFormInt(r, "aiVoterDaily", 1, 1000)
	if err != nil {
		return aiAdminSettings{}, err
	}
	siteCalls, err := parseBoundedFormInt(r, "aiSiteCalls", 1, 1000000)
	if err != nil {
		return aiAdminSettings{}, err
	}
	siteTokens, err := parseBoundedFormInt(r, "aiSiteTokens", 1000, 1000000000)
	if err != nil {
		return aiAdminSettings{}, err
	}
	apiKey := strings.TrimSpace(r.Form.Get("aiAPIKey"))
	if len(apiKey) > 4096 || strings.ContainsAny(apiKey, "\r\n") {
		return aiAdminSettings{}, fmt.Errorf("API Key 格式不合法")
	}
	return aiAdminSettings{
		BaseURL: baseURL, Model: model, SystemPrompt: prompt,
		Temperature: strconv.FormatFloat(temperature, 'f', -1, 64), MaxTokens: maxTokens,
		Timeout: timeout, VoterDaily: voterDaily, SiteCalls: siteCalls, SiteTokens: siteTokens, APIKey: apiKey,
	}, nil
}

func parseBoundedFormInt(r *http.Request, name string, min, max int) (int, error) {
	value, err := strconv.Atoi(strings.TrimSpace(r.Form.Get(name)))
	if err != nil || value < min || value > max {
		return 0, fmt.Errorf("%s 须为 %d–%d 的整数", name, min, max)
	}
	return value, nil
}

func numberInput(name, label, value string, min, max int) string {
	return fmt.Sprintf(`<div class="field"><label>%s</label><input type="number" name="%s" value="%s" min="%d" max="%d" required></div>`, template.HTMLEscapeString(label), name, template.HTMLEscapeString(value), min, max)
}

func decimalField(name, label, value, min, max, step string) string {
	return `<div class="field"><label>` + template.HTMLEscapeString(label) + `</label><input type="number" name="` + name + `" value="` + template.HTMLEscapeString(value) + `" min="` + min + `" max="` + max + `" step="` + step + `" required></div>`
}
