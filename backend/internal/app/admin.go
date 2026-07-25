package app

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const adminCookie = "jxnu_admin_session"

type adminSession struct {
	Expires time.Time
	CSRF    string
}
type AdminServer struct {
	env          Environment
	config       *ConfigStore
	enrollment   *EnrollmentService
	live         *LiveStudentService
	syncRunner   *SyncRunner
	cloudflare   *CloudflarePagesClient
	cloudflareMu sync.RWMutex
	logger       *slog.Logger
	mu           sync.Mutex
	// adminPassword is the live panel password. It starts from the environment
	// but 部署配置 can change it without a restart, so login() must read this
	// rather than a.env.AdminPassword.
	adminPassword string
	sessions      map[string]adminSession
	loginFailures int

	namesMu   sync.Mutex
	nameCache *reviewNameCache
	namesAt   time.Time

	schema d1SchemaState
}

func NewAdminServer(env Environment, config *ConfigStore, enrollment *EnrollmentService, live *LiveStudentService, syncRunner *SyncRunner, logger *slog.Logger) *AdminServer {
	return &AdminServer{env: env, config: config, enrollment: enrollment, live: live, syncRunner: syncRunner, cloudflare: NewCloudflarePagesClient(env), logger: logger, adminPassword: env.AdminPassword, sessions: map[string]adminSession{}}
}
func (a *AdminServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", a.health)
	mux.HandleFunc("/login", a.login)
	mux.HandleFunc("/logout", a.auth(a.logout))
	mux.HandleFunc("/", a.auth(a.dashboard))
	mux.HandleFunc("/settings", a.auth(a.settings))
	mux.HandleFunc("/operations", a.auth(a.operations))
	mux.HandleFunc("/logs", a.auth(a.logs))
	mux.HandleFunc("/ai", a.auth(a.aiSettings))
	mux.HandleFunc("/reviews", a.auth(a.reviewsPage))
	mux.HandleFunc("/reviews/edit", a.auth(a.reviewEditPage))
	mux.HandleFunc("/reviews/trash", a.auth(a.trashPage))
	mux.HandleFunc("/reviews/audit", a.auth(a.auditPage))
	mux.HandleFunc("/advanced", a.auth(a.advanced))
	mux.HandleFunc("/deployment", a.auth(a.deployment))
	mux.HandleFunc("/action/save-site", a.auth(a.saveSiteIdentity))
	mux.HandleFunc("/action/save-cloudflare-all", a.auth(a.saveCloudflareAll))
	mux.HandleFunc("/action/save-credentials", a.auth(a.saveCredentials))
	mux.HandleFunc("/action/save-admin-password", a.auth(a.saveAdminPassword))
	mux.HandleFunc("/action/restart-backend", a.auth(a.restartBackend))
	mux.HandleFunc("/action/save-daily", a.auth(a.saveDaily))
	mux.HandleFunc("/action/save-advanced", a.auth(a.saveAdvanced))
	mux.HandleFunc("/action/sync", a.auth(a.startSync))
	mux.HandleFunc("/action/build", a.auth(a.startBuild))
	mux.HandleFunc("/action/refresh-enrollment", a.auth(a.refreshEnrollment))
	mux.HandleFunc("/action/save-automation", a.auth(a.saveAutomation))
	mux.HandleFunc("/action/save-ai", a.auth(a.saveAI))
	mux.HandleFunc("/action/redeploy-ai", a.auth(a.redeployAI))
	mux.HandleFunc("/action/save-cloudflare", a.auth(a.saveCloudflareConnection))
	mux.HandleFunc("/action/save-review", a.auth(a.saveReview))
	mux.HandleFunc("/action/delete-review", a.auth(a.deleteReview))
	mux.HandleFunc("/action/purge-reviews", a.auth(a.purgeReviews))
	mux.HandleFunc("/action/review-moderation", a.auth(a.toggleReviewModeration))
	mux.HandleFunc("/action/save-turnstile", a.auth(a.saveTurnstile))
	mux.HandleFunc("/action/turnstile-off", a.auth(a.disableTurnstile))
	mux.HandleFunc("/action/save-captcha", a.auth(a.saveCaptcha))
	mux.HandleFunc("/action/captcha-off", a.auth(a.disableCaptcha))
	mux.HandleFunc("/action/moderate-review", a.auth(a.moderateReview))
	mux.HandleFunc("/action/restore-review", a.auth(a.restoreReview))
	mux.HandleFunc("/action/purge-trash", a.auth(a.purgeTrash))
	mux.HandleFunc("/action/resolve-report", a.auth(a.resolveReport))
	mux.HandleFunc("/action/save-d1", a.auth(a.saveD1Connection))
	return recoverMiddleware(a.logger, mux)
}

func (a *AdminServer) cloudflareClient() *CloudflarePagesClient {
	a.cloudflareMu.RLock()
	defer a.cloudflareMu.RUnlock()
	return a.cloudflare
}

func (a *AdminServer) setCloudflareClient(client *CloudflarePagesClient) {
	a.cloudflareMu.Lock()
	a.cloudflare = client
	a.cloudflareMu.Unlock()
}
func (a *AdminServer) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"ok": true, "service": "jxnu-backend-admin"}, http.StatusOK, "")
}
func (a *AdminServer) auth(next func(http.ResponseWriter, *http.Request, adminSession)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(adminCookie)
		if err != nil {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		a.mu.Lock()
		session, ok := a.sessions[cookie.Value]
		if ok && time.Now().After(session.Expires) {
			delete(a.sessions, cookie.Value)
			ok = false
		}
		a.mu.Unlock()
		if !ok {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		next(w, r, session)
	}
}
func (a *AdminServer) login(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		a.render(w, "登录", loginHTML(""), nil)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	_ = r.ParseForm()
	password := r.Form.Get("password")
	a.mu.Lock()
	fails := a.loginFailures
	stored := a.adminPassword
	a.mu.Unlock()
	if fails >= 5 {
		time.Sleep(3 * time.Second)
	}
	// stored (not a.env.AdminPassword) — 部署配置 can rotate it without a restart.
	ok := stored != "" && len(password) == len(stored) && subtle.ConstantTimeCompare([]byte(password), []byte(stored)) == 1
	if !ok {
		a.mu.Lock()
		a.loginFailures++
		a.mu.Unlock()
		a.renderStatus(w, "登录", loginHTML("密码错误"), http.StatusUnauthorized)
		return
	}
	token := randomToken(32)
	session := adminSession{time.Now().Add(8 * time.Hour), randomToken(16)}
	a.mu.Lock()
	a.loginFailures = 0
	a.sessions[token] = session
	a.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: adminCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 8 * 3600})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}
func (a *AdminServer) logout(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	if cookie, err := r.Cookie(adminCookie); err == nil {
		a.mu.Lock()
		delete(a.sessions, cookie.Value)
		a.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: adminCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}
func (a *AdminServer) dashboard(w http.ResponseWriter, r *http.Request, session adminSession) {
	if r.URL.Path != "/" {
		a.renderStatus(w, "未找到", "<section class=card><h2>页面不存在</h2></section>", 404)
		return
	}
	cfg := a.config.Get()
	profile := cfg.ActiveAcquisitionProfile()
	enrollment := a.enrollment.Status()
	live := a.live.Health()
	syncStatus := a.syncRunner.Status()
	liveTarget := cfg.LiveEnrollmentTarget()
	enrollmentState := "等待首份快照"
	if liveTarget == "" {
		enrollmentState = "按预选阶段关闭"
	} else if enrollment.OK {
		enrollmentState = "正常"
	}
	liveTargetLabel := liveTarget
	if liveTargetLabel == "" {
		liveTargetLabel = "预选不提供实时人数"
	}
	body := fmt.Sprintf(`<section class="hero"><div><p class="eyebrow">JXNU 选课 PLUS</p><h1>后端控制中心</h1><p>这里显示的是业务状态，不需要记端口、env 名或 systemd 命令。</p></div><a class="button" href="/settings">修改日常设置</a></section>
<div class="grid three"><section class="card"><span class="status %s"></span><h2>实时人数</h2><p class="big">%s</p><p>%s · %d 个教学班</p></section><section class="card"><span class="status %s"></span><h2>学号实时课表</h2><p class="big">%s</p><p>缓存 %v 条 · %s</p></section><section class="card"><span class="status %s"></span><h2>自动同步</h2><p class="big">%s</p><p>%s</p></section></div>
<section class="card"><h2>当前对外语义</h2><dl class="facts"><div><dt>网站默认打开</dt><dd>%s</dd></div><div><dt>实时人数</dt><dd>%s</dd></div><div><dt>生效采集管线</dt><dd>%s · %s<br><small>%s</small></dd></div><div><dt>学号课表查询</dt><dd>%s</dd></div></dl></section>`, okClass(enrollment.OK || liveTarget == ""), enrollmentState, liveTargetLabel, classCount(enrollment), okClass(boolValue(live["ok"])), map[bool]string{true: "可用", false: "未配置"}[boolValue(live["ok"])], live["cacheSize"], studentTermLabel(cfg.StudentScheduleTerm), okClass(syncStatus.State == "success" || syncStatus.State == "unchanged" || syncStatus.State == "waiting" || syncStatus.State == "never"), syncStateLabel(syncStatus.State), template.HTMLEscapeString(syncStatus.Message), dataSourceLabel(cfg.DefaultDataSource), liveTargetLabel, profile.Label, profile.Semester, academicTermLabel(profile.Semester), studentTermLabel(cfg.StudentScheduleTerm))
	a.render(w, "总览", body, &session)
}
func (a *AdminServer) settings(w http.ResponseWriter, r *http.Request, session adminSession) {
	cfg := a.config.Get()
	semesters := SemesterOptions(a.env.RepoDir)
	targetSemesters := SemesterTargetOptions(semesters, cfg.PreselectSemester, time.Now())
	targetSemesters = SemesterTargetOptions(targetSemesters, cfg.SelectionSemester, time.Now())
	terms := AcademicTermOptions(semesters, cfg.StudentScheduleTerm, time.Now())
	for _, term := range a.live.AvailableTerms() {
		if !contains(terms, term) {
			terms = append(terms, term)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(terms)))
	targetField := func(name, value string) string {
		return `<input name="` + name + `" list="semester-target-options" value="` + template.HTMLEscapeString(value) + `" pattern="\d{4}-(03|09)" required><p class="hint">教务映射：` + template.HTMLEscapeString(value) + ` → ` + template.HTMLEscapeString(academicTermLabel(value)) + `</p>`
	}
	body := `<section class="hero"><div><p class="eyebrow">日常只需要这一页</p><h1>展示与查询设置</h1><p>默认展示阶段同时决定当前自动任务使用哪条采集管线；三个阶段的目标与 raw 永久分开。</p></div></section><form method="post" action="/action/save-daily" class="stack">` + csrf(session) +
		`<section class="card"><h2>1. 网站默认打开哪个阶段？</h2><p class="hint">保存后，该阶段对应的采集与实时人数策略生效；正选和补退选共用同一个入口、课表和目标学期。</p><div class="choices">` + radio("defaultDataSource", "pre", "预选", "CAS 课程目录；无实时人数", cfg.DefaultDataSource) + radio("defaultDataSource", "formal", "正选/补退选", "同一 KKAP 课表；容量 URL 按时间手动切换", cfg.DefaultDataSource) + `</div></section>` +
		`<section class="card"><h2>2. 预选数据写入哪个学期？ ` + activeBadge(cfg.DefaultDataSource == "pre") + `</h2><p class="hint">目标文件：<code>raw/preselect_catalog.json</code>。它只能由选课系统 CAS 页面提供；KKAP 无法代替。当前联网采集器保持关闭，系统只接收已有/手工 raw，也绝不探测人数或容量。</p>` + targetField("preselectSemester", cfg.PreselectSemester) + `</section>` +
		`<section class="card"><h2>3. 正选/补退选数据写入哪个学期？ ` + activeBadge(cfg.DefaultDataSource == "formal") + `</h2><p class="hint">唯一目标文件：<code>raw/formal_schedule.json</code>。两个时段的课程课表完全一致；阶段变化只在高级设置里切换容量嗅探 URL。</p>` + targetField("selectionSemester", cfg.SelectionSemester) + `</section>` +
		`<datalist id="semester-target-options">` + options(targetSemesters, "") + `</datalist>` +
		`<section class="card"><h2>4. 查学号时使用哪一学期的实时课表？</h2><p class="hint">“自动”使用教务当前选中的学期；“指定”会让后端真正切换到所选学期。</p><label class="inline"><input type="radio" name="studentTermMode" value="auto" ` + checked(cfg.StudentScheduleTerm == "") + `> 自动跟随教务</label><label class="inline"><input type="radio" name="studentTermMode" value="fixed" ` + checked(cfg.StudentScheduleTerm != "") + `> 指定学期</label><input name="studentScheduleTerm" list="term-options" value="` + template.HTMLEscapeString(cfg.StudentScheduleTerm) + `" placeholder="例如 26-27第1学期"><datalist id="term-options">` + options(terms, cfg.StudentScheduleTerm) + `</datalist></section>` +
		`<section class="card"><h2>5. 哪一学期的成绩已经出完？ ` + finalizedBadge(cfg.FinalizedTerm) + `</h2><p class="hint">决定「已修学分（不含本学期）」算到哪为止。教务问不出来这件事——它一开放选课就把当前学期切到下一个，于是刚读完的学期在系统看来仍是「在读」，那一学期的学分会被扣住不算。每学期补退选结束、成绩出完后，把这里往前推一个学期即可（<b>固化学期</b>操作会自动帮你设好）。</p>` +
		`<input name="finalizedTerm" list="term-options" value="` + template.HTMLEscapeString(cfg.FinalizedTerm) + `" placeholder="留空 = 沿用旧口径（整个在读学期都不算）"><p class="hint">留空时行为不变：在读学期的学分一律不计入已修。</p></section>` +
		`<button class="button primary" type="submit">保存并立即应用</button></form>`
	a.render(w, "日常设置", body, &session)
}
func (a *AdminServer) operations(w http.ResponseWriter, r *http.Request, session adminSession) {
	status := a.syncRunner.Status()
	cfg := a.config.Get()
	profile := cfg.ActiveAcquisitionProfile()
	acquireButton := "立即联网采集并构建"
	if profile.DataSource == "pre" {
		acquireButton = "检查预选 raw 并构建"
	}
	liveCard := `<section class="card"><h2>实时人数</h2><p>当前阶段会按 ` + template.HTMLEscapeString(profile.Semester) + ` 刷新 KKAP 人数。</p><form method="post" action="/action/refresh-enrollment">` + csrf(session) + `<button class="button">立即刷新人数</button></form></section>`
	if !profile.LiveEnrollment {
		liveCard = `<section class="card"><h2>实时人数</h2><p class="hint">预选目录没有实时人数语义，后端与前端轮询均已自动关闭；无需配置一个假的“实时人数学期”。</p></section>`
	}
	body := fmt.Sprintf(`<section class="hero"><div><p class="eyebrow">任务与检查</p><h1>自动构建与数据同步</h1><p>当前只运行 <b>%s</b> 管线：%s → %s。</p></div><a class="button" href="/logs?source=sync">查看同步日志</a></section>
<section class="card"><h2>最近一次任务：%s</h2><p>%s</p><dl class="facts"><div><dt>阶段</dt><dd>%s</dd></div><div><dt>开始</dt><dd>%s</dd></div><div><dt>结束</dt><dd>%s</dd></div><div><dt>目标学期</dt><dd>%s</dd></div><div><dt>预选课程</dt><dd>%d</dd></div><div><dt>产物教学班</dt><dd>%d</dd></div><div><dt>课程详情缓存</dt><dd>%d 门</dd></div></dl><div class="action-row"><form method="post" action="/action/sync">%s<button class="button primary">%s</button></form><form method="post" action="/action/build">%s<button class="button">仅构建现有 raw</button></form></div></section>
<form method="post" action="/action/save-automation" class="stack">%s<section class="card"><h2>自动构建调度</h2><label class="inline"><input type="checkbox" name="autoSyncEnabled" %s> 启用自动构建</label>%s<p class="hint">timer 只在预选与正选/补退选两条管线之间切换。</p></section>
<section class="card"><h2>正选/补退选 KKAP 课表守候</h2><label class="inline"><input type="checkbox" name="selectionScheduleWatchEnabled" %s> 自动抓取唯一的 <code>formal_schedule.json</code></label><p class="hint">目标：<b>%s → %s</b>。正选和补退选课表完全一致，不存在第二份 addDrop 课表。授课人数变化不影响结构稳定判断。</p>%s</section>
<section class="card"><h2>登录后自动补齐学分</h2><label class="inline"><input type="checkbox" name="courseDetailsEnabled" %s> 对正选/补退选共用课表自动补齐基础课程信息</label><p class="hint">预选阶段不走这条路径。基础学分缺失时才经 CAS 读取课程简介页，无需维护课程号名单。</p><div class="grid three">%s%s%s</div></section><button class="button primary" type="submit">保存自动构建配置</button></form>%s`,
		profile.Label, profile.Semester, academicTermLabel(profile.Semester), syncStateLabel(status.State), template.HTMLEscapeString(status.Message), dataSourceLabel(status.DataSource), emptyDash(status.StartedAt), emptyDash(status.FinishedAt), emptyDash(status.Semester), status.Courses, status.FormalSections, status.CourseDetails, csrf(session), acquireButton, csrf(session), csrf(session), checked(cfg.AutoSyncEnabled), numberInput("autoSyncIntervalMinutes", "实际构建间隔（分钟）", strconv.Itoa(cfg.AutoSyncIntervalMinutes), 15, 1440), checked(cfg.SelectionScheduleWatchEnabled), cfg.SelectionSemester, academicTermLabel(cfg.SelectionSemester), numberInput("formalScheduleStableChecks", "连续结构稳定次数", strconv.Itoa(cfg.FormalScheduleStableChecks), 1, 10), checked(cfg.CourseDetailsEnabled), numberInput("courseDetailsRefreshHours", "缺学分课程复核周期（小时）", strconv.Itoa(cfg.CourseDetailsRefreshHours), 1, 8760), numberInput("courseDetailsMaxPerRun", "每轮最多补齐课程", strconv.Itoa(cfg.CourseDetailsMaxPerRun), 1, 200), numberInput("courseDetailsDelayMilliseconds", "每门间隔（毫秒）", strconv.Itoa(cfg.CourseDetailsDelayMilliseconds), 100, 10000), liveCard)
	a.render(w, "任务", body, &session)
}
func (a *AdminServer) advanced(w http.ResponseWriter, r *http.Request, session adminSession) {
	cfg := a.config.Get()
	body := fmt.Sprintf(`<section class="hero"><div><p class="eyebrow">平时无需修改</p><h1>高级设置</h1><p>正选与补退选共用课表和容量快照；阶段切换时只改下面的嗅探 URL。</p></div></section><form method="post" action="/action/save-advanced" class="stack">%s<section class="card"><h2>刷新与缓存</h2>%s%s</section>
<section class="card"><h2>正选/补退选容量嗅探</h2><label class="inline"><input type="checkbox" name="selectionCapacityEnabled" %s> 启用容量抓取</label><p class="hint">从同一份 <code>formal_schedule.json</code> 读取课程号，结果写入 <code>formal_capacity.json</code>。正选转补退选时只需把 URL 改为当时真实页面地址；必须保留 <code>{courseId}</code> 占位符，且只允许 xk.jxnu.edu.cn。</p>%s%s</section>
<section class="card"><h2>异常数据安全闸</h2><div class="grid three">%s%s%s</div></section><section class="card"><h2>CORS 白名单</h2><textarea name="allowedOrigins" rows="6">%s</textarea><p class="hint">一行一个前端来源。保存后热更新。</p></section><button class="button primary">保存高级设置</button></form><section class="card"><h2>凭据状态</h2><dl class="facts"><div><dt>教务账号</dt><dd>%s</dd></div><div><dt>学号 API 密钥</dt><dd>%s</dd></div><div><dt>管理密码</dt><dd>%s</dd></div></dl><p class="hint">密钥仍在 VPS 的 backend.env 中维护。</p></section>`, csrf(session), numberField("enrollmentRefreshSeconds", "实时人数刷新（秒）", cfg.EnrollmentRefreshSeconds), numberField("studentCacheSeconds", "学号结果缓存（秒）", cfg.StudentCacheSeconds), checked(cfg.SelectionCapacityEnabled), textField("selectionCapacityUrl", "容量嗅探完整 URL", cfg.SelectionCapacityURL), numberField("capacityDelayMilliseconds", "每门课间隔（毫秒）", cfg.CapacityDelayMilliseconds), numberField("minSelectionScheduleRows", "课表 raw 最少行数", cfg.MinSelectionScheduleRows), numberField("minSelectionSections", "目标学期最少教学班", cfg.MinSelectionSections), numberField("minSelectionCapacityVisible", "容量最少可见课程", cfg.MinSelectionCapacityVisible), template.HTMLEscapeString(strings.Join(cfg.AllowedOrigins, "\n")), configured(a.env.XKUsername), configured(a.env.LiveSecret), configured(a.env.AdminPassword))
	a.render(w, "高级设置", body, &session)
}
func (a *AdminServer) saveDaily(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cfg := a.config.Get()
	cfg.DefaultDataSource = r.Form.Get("defaultDataSource")
	cfg.PreselectSemester = strings.TrimSpace(r.Form.Get("preselectSemester"))
	cfg.SelectionSemester = strings.TrimSpace(r.Form.Get("selectionSemester"))
	if r.Form.Get("studentTermMode") == "auto" {
		cfg.StudentScheduleTerm = ""
	} else {
		cfg.StudentScheduleTerm = strings.TrimSpace(r.Form.Get("studentScheduleTerm"))
	}
	cfg.FinalizedTerm = strings.TrimSpace(r.Form.Get("finalizedTerm"))
	if err := a.config.Save(cfg); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.live.ClearCache()
	a.enrollment.Wake()
	a.result(w, "设置已生效", "默认阶段对应的采集管线和实时人数策略已立即切换；学号查询缓存已清空。", true, &session)
}
func (a *AdminServer) saveAdvanced(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	current := a.config.Get()
	cfg, err := ParseRuntimeForm(map[string]string{"defaultDataSource": current.DefaultDataSource, "preselectSemester": current.PreselectSemester, "selectionSemester": current.SelectionSemester, "studentTermMode": map[bool]string{true: "auto", false: "fixed"}[current.StudentScheduleTerm == ""], "studentScheduleTerm": current.StudentScheduleTerm, "enrollmentRefreshSeconds": r.Form.Get("enrollmentRefreshSeconds"), "studentCacheSeconds": r.Form.Get("studentCacheSeconds"), "selectionCapacityEnabled": r.Form.Get("selectionCapacityEnabled"), "selectionCapacityUrl": r.Form.Get("selectionCapacityUrl"), "capacityDelayMilliseconds": r.Form.Get("capacityDelayMilliseconds"), "minSelectionScheduleRows": r.Form.Get("minSelectionScheduleRows"), "minSelectionSections": r.Form.Get("minSelectionSections"), "minSelectionCapacityVisible": r.Form.Get("minSelectionCapacityVisible"), "allowedOrigins": r.Form.Get("allowedOrigins")}, current)
	if err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	if err = a.config.Save(cfg); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.enrollment.Wake()
	a.result(w, "高级设置已生效", "无需重启服务。", true, &session)
}

func (a *AdminServer) saveAutomation(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cfg, err := ParseAutomationForm(map[string]string{
		"autoSyncEnabled":                r.Form.Get("autoSyncEnabled"),
		"autoSyncIntervalMinutes":        r.Form.Get("autoSyncIntervalMinutes"),
		"selectionScheduleWatchEnabled":  r.Form.Get("selectionScheduleWatchEnabled"),
		"formalScheduleStableChecks":     r.Form.Get("formalScheduleStableChecks"),
		"courseDetailsEnabled":           r.Form.Get("courseDetailsEnabled"),
		"courseDetailsRefreshHours":      r.Form.Get("courseDetailsRefreshHours"),
		"courseDetailsMaxPerRun":         r.Form.Get("courseDetailsMaxPerRun"),
		"courseDetailsDelayMilliseconds": r.Form.Get("courseDetailsDelayMilliseconds"),
	}, a.config.Get())
	if err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	if err := a.config.Save(cfg); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.result(w, "自动构建配置已生效", "下一次 timer 唤醒会读取新配置；手动构建可立即验证。", true, &session)
}
func (a *AdminServer) startSync(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	status := a.syncRunner.Status()
	if status.State == "running" {
		a.result(w, "任务已在运行", "请等待当前同步结束。", false, &session)
		return
	}
	exe, err := os.Executable()
	if err != nil {
		a.result(w, "启动失败", err.Error(), false, &session)
		return
	}
	cmd := exec.Command(exe, "sync")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err = cmd.Start(); err != nil {
		a.result(w, "启动失败", err.Error(), false, &session)
		return
	}
	profile := a.config.Get().ActiveAcquisitionProfile()
	a.syncRunner.setStatus(SyncStatus{State: "queued", StartedAt: time.Now().UTC().Format(time.RFC3339), Message: profile.Label + "管线任务已启动，稍后刷新任务页查看结果", DataSource: profile.DataSource, Semester: profile.Semester})
	a.result(w, "同步已启动", "任务在后台运行，不需要保持此页面打开。", true, &session)
}

func (a *AdminServer) startBuild(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	status := a.syncRunner.Status()
	if status.State == "running" || status.State == "queued" {
		a.result(w, "任务已在运行", "请等待当前任务结束。", false, &session)
		return
	}
	exe, err := os.Executable()
	if err != nil {
		a.result(w, "启动失败", err.Error(), false, &session)
		return
	}
	cmd := exec.Command(exe, "build")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err = cmd.Start(); err != nil {
		a.result(w, "启动失败", err.Error(), false, &session)
		return
	}
	profile := a.config.Get().ActiveAcquisitionProfile()
	a.syncRunner.setStatus(SyncStatus{State: "queued", StartedAt: time.Now().UTC().Format(time.RFC3339), Message: profile.Label + "离线构建已启动，不会访问教务采集页面", DataSource: profile.DataSource, Semester: profile.Semester})
	a.result(w, "离线构建已启动", "仅使用仓库中现有 raw；任务在后台运行。", true, &session)
}
func (a *AdminServer) refreshEnrollment(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	a.enrollment.Wake()
	a.result(w, "已安排刷新", "后台会立即抓取一份新的实时人数快照。", true, &session)
}
func (a *AdminServer) validPost(w http.ResponseWriter, r *http.Request, session adminSession) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return false
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", 400)
		return false
	}
	token := r.Form.Get("csrf")
	if len(token) != len(session.CSRF) || subtle.ConstantTimeCompare([]byte(token), []byte(session.CSRF)) != 1 {
		http.Error(w, "CSRF 校验失败", 403)
		return false
	}
	return true
}
func (a *AdminServer) result(w http.ResponseWriter, title, message string, ok bool, session *adminSession) {
	class := "error"
	if ok {
		class = "success"
	}
	a.render(w, title, `<section class="card result `+class+`"><h1>`+template.HTMLEscapeString(title)+`</h1><p>`+template.HTMLEscapeString(message)+`</p><p><a class="button" href="/">返回总览</a></p></section>`, session)
}
func (a *AdminServer) render(w http.ResponseWriter, title, body string, session *adminSession) {
	a.renderStatus(w, title, layoutHTML(title, body, session), 200)
}
func (a *AdminServer) renderStatus(w http.ResponseWriter, title, body string, status int) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func layoutHTML(title, body string, session *adminSession) string {
	nav := ""
	if session != nil {
		nav = `<nav><a href="/">总览</a><a href="/settings">日常设置</a><a href="/operations">自动构建</a><a href="/logs">日志</a><a href="/reviews">评价管理</a><a href="/ai">AI 配置</a><a href="/deployment">部署</a><a href="/advanced">高级</a><form method="post" action="/logout"><input type="hidden" name="csrf" value="` + session.CSRF + `"><button class="link">退出</button></form></nav>`
	}
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` + template.HTMLEscapeString(title) + ` · JXNU 后端</title><style>` + adminCSS + adminCSSFixes + `</style></head><body><header><strong>JXNU 后端</strong>` + nav + `</header><main>` + body + `</main><footer>Go ` + runtime.Version() + ` · 面板仅监听 VPS 回环地址</footer></body></html>`
}

const adminCSSFixes = `input[type=checkbox]{width:auto}.rev-title,.rev-meta,.rev-quote,code{overflow-wrap:anywhere;word-break:break-word}.rev-title{min-width:0}.rev-quote{white-space:pre-wrap}.tbl td{overflow-wrap:anywhere}`

const adminCSS = `:root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#201a1a;background:#f7f4f1}*{box-sizing:border-box}body{margin:0}header{height:64px;padding:0 max(20px,calc((100% - 1100px)/2));display:flex;align-items:center;justify-content:space-between;background:#701c23;color:#fff}nav{display:flex;align-items:center;gap:6px}nav a,.link{color:#fff;text-decoration:none;background:transparent;border:0;padding:9px 10px;font:inherit;cursor:pointer}nav a:hover,.link:hover{background:#ffffff20;border-radius:8px}nav form{margin:0}main{max-width:1100px;margin:0 auto;padding:32px 20px 80px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin:8px 0 28px}.hero h1{font-size:34px;margin:4px 0}.hero p{margin:5px 0;color:#6b6060}.eyebrow{color:#9a333d!important;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.grid{display:grid;gap:16px}.three{grid-template-columns:repeat(3,1fr)}.card{background:#fff;border:1px solid #e8dfda;border-radius:16px;padding:22px;box-shadow:0 5px 18px #5f292908;margin-bottom:16px}.card h2{font-size:18px;margin:0 0 12px}.big{font-size:25px;font-weight:750;margin:6px 0!important}.status{display:block;width:10px;height:10px;border-radius:50%;background:#c0363f;float:right}.status.ok{background:#2f9e62}.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.facts div{background:#faf7f5;border-radius:10px;padding:12px}.facts dt{color:#776c68;font-size:12px}.facts dd{margin:5px 0 0;font-weight:700}.stack{display:grid;gap:4px}.choices{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.choice{border:1px solid #ddd2cc;border-radius:12px;padding:13px;display:flex;gap:10px;align-items:flex-start}.choice b{display:block}.choice small{color:#776c68}.hint{color:#776c68;font-size:13px;line-height:1.65}label.inline{display:inline-flex;align-items:center;gap:7px;margin:5px 18px 12px 0}input,select,textarea{width:100%;border:1px solid #cfc4be;border-radius:9px;padding:11px;background:#fff;font:inherit}input[type=radio]{width:auto}.field{margin:12px 0}.field label{display:block;font-size:13px;font-weight:700;margin-bottom:6px}.prompt{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.6}.button{display:inline-block;border:0;border-radius:9px;padding:11px 17px;text-decoration:none;background:#5c5654;color:#fff;font:inherit;cursor:pointer}.primary{background:#8b2631}.actions{display:flex;justify-content:flex-end;margin:8px 0 22px}.action-row{display:flex;gap:10px;flex-wrap:wrap}.action-row form{margin:0}.badge{display:inline-block;border-radius:999px;padding:4px 9px;background:#e5f5eb;color:#17653b;font-size:12px}.badge.warn{background:#fff1cf;color:#895d08}.badge.err{background:#fde2e2;color:#a51f27}.four{grid-template-columns:repeat(4,1fr)}.five{grid-template-columns:repeat(5,1fr)}.report.open{border-color:#e6b3b7;background:#fff6f6}.report-item{border:1px solid #e8dfda;border-radius:12px;padding:12px 14px;margin-bottom:14px;background:#faf7f5}.rev{background:#fff;border:1px solid #e8dfda;border-radius:14px;padding:16px 18px;margin-bottom:14px}.rev-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.rev-title{font-weight:700;font-size:15px;line-height:1.5}.rev-meta{margin:6px 0 10px}.rev-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}.rev-chip{border-radius:999px;padding:4px 11px;font-size:13px;font-weight:700;white-space:nowrap}.rev-quote{border-left:3px solid #ccc;padding:6px 12px;margin:8px 0;background:#faf7f5;border-radius:0 8px 8px 0;line-height:1.6;font-size:13px}.rev-quote-label{display:block;font-size:12px;font-weight:700;margin-bottom:2px}.rev-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}.rev-actions form{margin:0}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#7c2630}.log-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.log-view{margin:0;max-height:65vh;overflow:auto;border-radius:10px;background:#171515;color:#ece7e4;padding:16px;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}.success{border-left:5px solid #2f9e62}.error{border-left:5px solid #c0363f}.login{max-width:430px;margin:12vh auto}.login .button{width:100%;margin-top:10px}footer{text-align:center;color:#998e88;font-size:12px;padding:30px}.tbl-wrap{overflow-x:auto;margin:8px 0}.tbl{width:100%;border-collapse:collapse;font-size:12px}.tbl th,.tbl td{border:1px solid #e2d8d2;padding:6px;text-align:left;vertical-align:top}.tbl th{background:#faf3f0;white-space:nowrap}.tbl td .mini{margin:0}.tbl form{margin:0;display:inline}.pager{display:flex;gap:12px;align-items:center;margin:12px 0}.searchbar{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}.searchbar input,.searchbar select{width:auto}@media(max-width:760px){header{height:auto;padding:14px 18px;align-items:flex-start;gap:12px}nav{flex-wrap:wrap;justify-content:flex-end}.hero{align-items:flex-start;flex-direction:column}.three,.four,.five,.choices,.facts{grid-template-columns:1fr}.hero h1{font-size:28px}main{padding-top:22px}}`

func loginHTML(message string) string {
	errorHTML := ""
	if message != "" {
		errorHTML = `<p style="color:#b4232f">` + template.HTMLEscapeString(message) + `</p>`
	}
	return layoutHTML("登录", `<section class="card login"><p class="eyebrow">SSH 隧道内访问</p><h1>进入后端控制中心</h1><p class="hint">输入安装时保存的管理密码。</p>`+errorHTML+`<form method="post"><input type="password" name="password" required autofocus autocomplete="current-password"><button class="button primary">登录</button></form></section>`, nil)
}
func csrf(s adminSession) string { return `<input type="hidden" name="csrf" value="` + s.CSRF + `">` }
func randomToken(n int) string {
	raw := make([]byte, n)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}
func radio(name, value, title, desc, current string) string {
	return `<label class="choice"><input type="radio" name="` + name + `" value="` + value + `" ` + checked(value == current) + `><span><b>` + title + `</b><small>` + desc + `</small></span></label>`
}
func checked(ok bool) string {
	if ok {
		return "checked"
	}
	return ""
}
func options(values []string, current string) string {
	var b strings.Builder
	for _, value := range values {
		b.WriteString(`<option value="` + template.HTMLEscapeString(value) + `"`)
		if value == current {
			b.WriteString(" selected")
		}
		b.WriteString(`>` + template.HTMLEscapeString(value) + `</option>`)
	}
	return b.String()
}
func selectField(name, current string, values []string) string {
	return `<select name="` + name + `" required>` + options(values, current) + `</select>`
}
func numberField(name, label string, value int) string {
	return fmt.Sprintf(`<div class="field"><label>%s</label><input type="number" name="%s" value="%d" required></div>`, label, name, value)
}
func textField(name, label, value string) string {
	return `<div class="field"><label>` + label + `</label><input name="` + name + `" value="` + template.HTMLEscapeString(value) + `" required></div>`
}
func okClass(ok bool) string {
	if ok {
		return "ok"
	}
	return ""
}
func boolValue(value any) bool { v, _ := value.(bool); return v }
func classCount(state enrollmentState) int {
	if state.Snapshot != nil {
		return state.Snapshot.ClassCount
	}
	return 0
}
func studentTermLabel(value string) string {
	if value == "" {
		return "自动跟随教务"
	}
	return value
}
func dataSourceLabel(value string) string {
	label := map[string]string{"pre": "预选", "formal": "正选/补退选", "addDrop": "正选/补退选"}[value]
	if label == "" {
		return "—"
	}
	return label
}

// finalizedBadge shows whether 已修学分 is using the explicit finalized term or
// the older "exclude the whole reading semester" fallback.
func finalizedBadge(term string) string {
	if term == "" {
		return `<span class="badge warn">未设置（在读学期学分不计入）</span>`
	}
	return `<span class="badge">` + template.HTMLEscapeString(term) + ` 及以前计入已修</span>`
}

func activeBadge(active bool) string {
	if active {
		return `<span class="badge">当前生效</span>`
	}
	return ""
}
func syncStateLabel(value string) string {
	return map[string]string{"never": "尚未运行", "queued": "等待启动", "running": "运行中", "waiting": "待命", "success": "成功", "unchanged": "无变化", "failed": "失败"}[value]
}
func emptyDash(value string) string {
	if value == "" {
		return "—"
	}
	return value
}
func configured(value string) string {
	if value == "" {
		return "未配置"
	}
	return "已配置"
}
func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
