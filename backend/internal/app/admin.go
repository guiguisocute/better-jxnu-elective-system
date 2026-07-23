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
	env           Environment
	config        *ConfigStore
	enrollment    *EnrollmentService
	live          *LiveStudentService
	syncRunner    *SyncRunner
	cloudflare    *CloudflarePagesClient
	cloudflareMu  sync.RWMutex
	logger        *slog.Logger
	mu            sync.Mutex
	sessions      map[string]adminSession
	loginFailures int
}

func NewAdminServer(env Environment, config *ConfigStore, enrollment *EnrollmentService, live *LiveStudentService, syncRunner *SyncRunner, logger *slog.Logger) *AdminServer {
	return &AdminServer{env: env, config: config, enrollment: enrollment, live: live, syncRunner: syncRunner, cloudflare: NewCloudflarePagesClient(env), logger: logger, sessions: map[string]adminSession{}}
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
	mux.HandleFunc("/advanced", a.auth(a.advanced))
	mux.HandleFunc("/action/save-daily", a.auth(a.saveDaily))
	mux.HandleFunc("/action/save-advanced", a.auth(a.saveAdvanced))
	mux.HandleFunc("/action/sync", a.auth(a.startSync))
	mux.HandleFunc("/action/refresh-enrollment", a.auth(a.refreshEnrollment))
	mux.HandleFunc("/action/save-automation", a.auth(a.saveAutomation))
	mux.HandleFunc("/action/save-ai", a.auth(a.saveAI))
	mux.HandleFunc("/action/redeploy-ai", a.auth(a.redeployAI))
	mux.HandleFunc("/action/save-cloudflare", a.auth(a.saveCloudflareConnection))
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
	a.mu.Unlock()
	if fails >= 5 {
		time.Sleep(3 * time.Second)
	}
	ok := a.env.AdminPassword != "" && len(password) == len(a.env.AdminPassword) && subtle.ConstantTimeCompare([]byte(password), []byte(a.env.AdminPassword)) == 1
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
	enrollment := a.enrollment.Status()
	live := a.live.Health()
	syncStatus := a.syncRunner.Status()
	body := fmt.Sprintf(`<section class="hero"><div><p class="eyebrow">JXNU 选课 PLUS</p><h1>后端控制中心</h1><p>这里显示的是业务状态，不需要记端口、env 名或 systemd 命令。</p></div><a class="button" href="/settings">修改日常设置</a></section>
<div class="grid three"><section class="card"><span class="status %s"></span><h2>实时人数</h2><p class="big">%s</p><p>%s · %d 个教学班</p></section><section class="card"><span class="status %s"></span><h2>学号实时课表</h2><p class="big">%s</p><p>缓存 %v 条 · %s</p></section><section class="card"><span class="status %s"></span><h2>自动同步</h2><p class="big">%s</p><p>%s</p></section></div>
<section class="card"><h2>当前对外语义</h2><dl class="facts"><div><dt>网站默认打开</dt><dd>%s</dd></div><div><dt>实时人数属于</dt><dd>%s</dd></div><div><dt>同步写入</dt><dd>%s</dd></div><div><dt>学号课表查询</dt><dd>%s</dd></div></dl></section>`, okClass(enrollment.OK), map[bool]string{true: "正常", false: "等待首份快照"}[enrollment.OK], cfg.LiveEnrollmentSemester, classCount(enrollment), okClass(boolValue(live["ok"])), map[bool]string{true: "可用", false: "未配置"}[boolValue(live["ok"])], live["cacheSize"], studentTermLabel(cfg.StudentScheduleTerm), okClass(syncStatus.State == "success" || syncStatus.State == "unchanged" || syncStatus.State == "never"), syncStateLabel(syncStatus.State), template.HTMLEscapeString(syncStatus.Message), dataSourceLabel(cfg.DefaultDataSource), cfg.LiveEnrollmentSemester, cfg.ScheduleSyncSemester, studentTermLabel(cfg.StudentScheduleTerm))
	a.render(w, "总览", body, &session)
}
func (a *AdminServer) settings(w http.ResponseWriter, r *http.Request, session adminSession) {
	cfg := a.config.Get()
	semesters := SemesterOptions(a.env.RepoDir)
	terms := AcademicTermOptions(semesters, cfg.StudentScheduleTerm, time.Now())
	for _, term := range a.live.AvailableTerms() {
		if !contains(terms, term) {
			terms = append(terms, term)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(terms)))
	body := `<section class="hero"><div><p class="eyebrow">日常只需要这一页</p><h1>展示与查询设置</h1><p>保存后立即生效，不需要 SSH，也不需要逐个重启服务。</p></div></section><form method="post" action="/action/save-daily" class="stack">` + csrf(session) + `<section class="card"><h2>1. 网站默认打开哪个阶段？</h2><p class="hint">只影响没有保存过个人选择的新会话；用户主动切换后仍尊重用户选择。</p><div class="choices">` + radio("defaultDataSource", "pre", "预选", "课程目录", cfg.DefaultDataSource) + radio("defaultDataSource", "formal", "正选", "教学班、时间和容量", cfg.DefaultDataSource) + radio("defaultDataSource", "addDrop", "补退选", "补退选教学班", cfg.DefaultDataSource) + `</div></section><section class="card"><h2>2. 实时人数显示在哪个学期？</h2><p class="hint">后端快照和前端开关共用这个值，避免两边学期对不上。</p>` + selectField("liveEnrollmentSemester", cfg.LiveEnrollmentSemester, semesters) + `</section><section class="card"><h2>3. 每小时把新数据写入哪个学期？</h2><p class="hint">自动同步抓到的开课安排和容量会写入该学期目录。新学期目录需先存在。</p>` + selectField("scheduleSyncSemester", cfg.ScheduleSyncSemester, semesters) + `</section><section class="card"><h2>4. 查学号时使用哪一学期的实时课表？</h2><p class="hint">“自动”使用教务当前选中的学期；“指定”会让后端真正切换到所选学期，并忽略更晚学期。列表会随仓库和教务返回自动扩展，也可以直接输入新学期。</p><label class="inline"><input type="radio" name="studentTermMode" value="auto" ` + checked(cfg.StudentScheduleTerm == "") + `> 自动跟随教务</label><label class="inline"><input type="radio" name="studentTermMode" value="fixed" ` + checked(cfg.StudentScheduleTerm != "") + `> 指定学期</label><input name="studentScheduleTerm" list="term-options" value="` + template.HTMLEscapeString(cfg.StudentScheduleTerm) + `" placeholder="例如 26-27第1学期"><datalist id="term-options">` + options(terms, cfg.StudentScheduleTerm) + `</datalist></section><button class="button primary" type="submit">保存并立即应用</button></form>`
	a.render(w, "日常设置", body, &session)
}
func (a *AdminServer) operations(w http.ResponseWriter, r *http.Request, session adminSession) {
	status := a.syncRunner.Status()
	cfg := a.config.Get()
	body := fmt.Sprintf(`<section class="hero"><div><p class="eyebrow">任务与检查</p><h1>自动构建与数据同步</h1><p>timer 每 15 分钟检查一次；是否执行以及实际周期由下方配置决定。</p></div><a class="button" href="/logs?source=sync">查看同步日志</a></section>
<section class="card"><h2>最近一次任务：%s</h2><p>%s</p><dl class="facts"><div><dt>开始</dt><dd>%s</dd></div><div><dt>结束</dt><dd>%s</dd></div><div><dt>目标学期</dt><dd>%s</dd></div><div><dt>产物教学班</dt><dd>%d</dd></div><div><dt>课程详情缓存</dt><dd>%d 门</dd></div></dl><form method="post" action="/action/sync">%s<button class="button primary">立即完整构建一次</button></form></section>
<form method="post" action="/action/save-automation" class="stack">%s<section class="card"><h2>自动构建调度</h2><label class="inline"><input type="checkbox" name="autoSyncEnabled" %s> 启用自动构建</label>%s<p class="hint">系统级 timer 固定每 15 分钟轻量唤醒一次；未到配置间隔时直接退出，不访问学校网站。手动构建不受开关和间隔限制。</p></section>
<section class="card"><h2>登录后课程详情核查</h2><label class="inline"><input type="checkbox" name="courseDetailsEnabled" %s> 自动补齐公开课表缺少的课程信息</label><label class="inline"><input type="checkbox" name="courseDetailsVerifyTrackedEveryRun" %s> 每次构建都复核下方重点课程</label><div class="grid three">%s%s%s</div><div class="field"><label>重点核查课程号</label><textarea name="courseDetailCourseIDs" rows="6">%s</textarea><p class="hint">一行一个。系统还会自动发现没有内嵌课程信息的其他课程，并按每轮上限逐步补齐；失败会保留旧缓存，不阻断公开课表构建。</p></div></section><button class="button primary" type="submit">保存自动构建配置</button></form>
<section class="card"><h2>实时人数</h2><p>不必重启服务；可立即丢弃等待时间并重新抓一份。</p><form method="post" action="/action/refresh-enrollment">%s<button class="button">立即刷新人数</button></form></section>`,
		syncStateLabel(status.State), template.HTMLEscapeString(status.Message), emptyDash(status.StartedAt), emptyDash(status.FinishedAt), emptyDash(status.Semester), status.FormalSections, status.CourseDetails, csrf(session), csrf(session), checked(cfg.AutoSyncEnabled), numberInput("autoSyncIntervalMinutes", "实际构建间隔（分钟）", strconv.Itoa(cfg.AutoSyncIntervalMinutes), 15, 1440), checked(cfg.CourseDetailsEnabled), checked(cfg.CourseDetailsVerifyTrackedEveryRun), numberInput("courseDetailsRefreshHours", "普通课程复核周期（小时）", strconv.Itoa(cfg.CourseDetailsRefreshHours), 1, 8760), numberInput("courseDetailsMaxPerRun", "每轮最多核查课程", strconv.Itoa(cfg.CourseDetailsMaxPerRun), 1, 200), numberInput("courseDetailsDelayMilliseconds", "每门间隔（毫秒）", strconv.Itoa(cfg.CourseDetailsDelayMilliseconds), 100, 10000), template.HTMLEscapeString(strings.Join(cfg.CourseDetailCourseIDs, "\n")), csrf(session))
	a.render(w, "任务", body, &session)
}
func (a *AdminServer) advanced(w http.ResponseWriter, r *http.Request, session adminSession) {
	cfg := a.config.Get()
	body := fmt.Sprintf(`<section class="hero"><div><p class="eyebrow">平时无需修改</p><h1>高级设置</h1><p>只有教务阶段变化、性能调优或安全闸调整时才改这里。</p></div></section><form method="post" action="/action/save-advanced" class="stack">%s<section class="card"><h2>刷新与缓存</h2>%s%s</section><section class="card"><h2>容量抓取</h2><label class="inline"><input type="checkbox" name="capacityEnabled" %s> 启用教学班容量抓取</label><p class="hint">学校关闭选课期间请保持关闭；开选后再开启。关闭只跳过联网探测，已有容量文件不会被删除。</p>%s%s</section><section class="card"><h2>异常数据安全闸</h2>%s%s%s</section><section class="card"><h2>CORS 白名单</h2><textarea name="allowedOrigins" rows="6">%s</textarea><p class="hint">一行一个前端来源。保存后热更新。</p></section><button class="button primary">保存高级设置</button></form><section class="card"><h2>凭据状态</h2><dl class="facts"><div><dt>教务账号</dt><dd>%s</dd></div><div><dt>学号 API 密钥</dt><dd>%s</dd></div><div><dt>管理密码</dt><dd>%s</dd></div></dl><p class="hint">为避免网页误改导致全站中断，密钥在 VPS 的 backend.env 中维护。README 有完整命令。</p></section>`, csrf(session), numberField("enrollmentRefreshSeconds", "实时人数刷新（秒）", cfg.EnrollmentRefreshSeconds), numberField("studentCacheSeconds", "学号结果缓存（秒）", cfg.StudentCacheSeconds), checked(cfg.CapacityEnabled), textField("capacityStep", "选课阶段路径", cfg.CapacityStep), numberField("capacityDelayMilliseconds", "每门课间隔（毫秒）", cfg.CapacityDelayMilliseconds), numberField("minScheduleRows", "开课安排最少行数", cfg.MinScheduleRows), numberField("minFormalSections", "产物最少教学班数", cfg.MinFormalSections), numberField("minCapacityVisible", "容量最少可见课程数", cfg.MinCapacityVisible), template.HTMLEscapeString(strings.Join(cfg.AllowedOrigins, "\n")), configured(a.env.XKUsername), configured(a.env.LiveSecret), configured(a.env.AdminPassword))
	a.render(w, "高级设置", body, &session)
}
func (a *AdminServer) saveDaily(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cfg := a.config.Get()
	cfg.DefaultDataSource = r.Form.Get("defaultDataSource")
	cfg.LiveEnrollmentSemester = r.Form.Get("liveEnrollmentSemester")
	cfg.ScheduleSyncSemester = r.Form.Get("scheduleSyncSemester")
	if r.Form.Get("studentTermMode") == "auto" {
		cfg.StudentScheduleTerm = ""
	} else {
		cfg.StudentScheduleTerm = strings.TrimSpace(r.Form.Get("studentScheduleTerm"))
	}
	if err := a.config.Save(cfg); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.live.ClearCache()
	a.enrollment.Wake()
	a.result(w, "设置已生效", "实时人数会立即按新设置刷新；学号查询缓存已清空。", true, &session)
}
func (a *AdminServer) saveAdvanced(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cfg, err := ParseRuntimeForm(map[string]string{"defaultDataSource": a.config.Get().DefaultDataSource, "liveEnrollmentSemester": a.config.Get().LiveEnrollmentSemester, "scheduleSyncSemester": a.config.Get().ScheduleSyncSemester, "studentTermMode": map[bool]string{true: "auto", false: "fixed"}[a.config.Get().StudentScheduleTerm == ""], "studentScheduleTerm": a.config.Get().StudentScheduleTerm, "enrollmentRefreshSeconds": r.Form.Get("enrollmentRefreshSeconds"), "studentCacheSeconds": r.Form.Get("studentCacheSeconds"), "capacityEnabled": r.Form.Get("capacityEnabled"), "capacityStep": r.Form.Get("capacityStep"), "capacityDelayMilliseconds": r.Form.Get("capacityDelayMilliseconds"), "minScheduleRows": r.Form.Get("minScheduleRows"), "minFormalSections": r.Form.Get("minFormalSections"), "minCapacityVisible": r.Form.Get("minCapacityVisible"), "allowedOrigins": r.Form.Get("allowedOrigins")}, a.config.Get())
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
		"autoSyncEnabled":                    r.Form.Get("autoSyncEnabled"),
		"autoSyncIntervalMinutes":            r.Form.Get("autoSyncIntervalMinutes"),
		"courseDetailsEnabled":               r.Form.Get("courseDetailsEnabled"),
		"courseDetailsVerifyTrackedEveryRun": r.Form.Get("courseDetailsVerifyTrackedEveryRun"),
		"courseDetailsRefreshHours":          r.Form.Get("courseDetailsRefreshHours"),
		"courseDetailsMaxPerRun":             r.Form.Get("courseDetailsMaxPerRun"),
		"courseDetailsDelayMilliseconds":     r.Form.Get("courseDetailsDelayMilliseconds"),
		"courseDetailCourseIDs":              r.Form.Get("courseDetailCourseIDs"),
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
	a.syncRunner.setStatus(SyncStatus{State: "queued", StartedAt: time.Now().UTC().Format(time.RFC3339), Message: "任务已启动，稍后刷新任务页查看结果", Semester: a.config.Get().ScheduleSyncSemester})
	a.result(w, "同步已启动", "任务在后台运行，不需要保持此页面打开。", true, &session)
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
		nav = `<nav><a href="/">总览</a><a href="/settings">日常设置</a><a href="/operations">自动构建</a><a href="/logs">日志</a><a href="/ai">AI 配置</a><a href="/advanced">高级</a><form method="post" action="/logout"><input type="hidden" name="csrf" value="` + session.CSRF + `"><button class="link">退出</button></form></nav>`
	}
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` + template.HTMLEscapeString(title) + ` · JXNU 后端</title><style>` + adminCSS + `</style></head><body><header><strong>JXNU 后端</strong>` + nav + `</header><main>` + body + `</main><footer>Go ` + runtime.Version() + ` · 面板仅监听 VPS 回环地址</footer></body></html>`
}

const adminCSS = `:root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#201a1a;background:#f7f4f1}*{box-sizing:border-box}body{margin:0}header{height:64px;padding:0 max(20px,calc((100% - 1100px)/2));display:flex;align-items:center;justify-content:space-between;background:#701c23;color:#fff}nav{display:flex;align-items:center;gap:6px}nav a,.link{color:#fff;text-decoration:none;background:transparent;border:0;padding:9px 10px;font:inherit;cursor:pointer}nav a:hover,.link:hover{background:#ffffff20;border-radius:8px}nav form{margin:0}main{max-width:1100px;margin:0 auto;padding:32px 20px 80px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin:8px 0 28px}.hero h1{font-size:34px;margin:4px 0}.hero p{margin:5px 0;color:#6b6060}.eyebrow{color:#9a333d!important;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.grid{display:grid;gap:16px}.three{grid-template-columns:repeat(3,1fr)}.card{background:#fff;border:1px solid #e8dfda;border-radius:16px;padding:22px;box-shadow:0 5px 18px #5f292908;margin-bottom:16px}.card h2{font-size:18px;margin:0 0 12px}.big{font-size:25px;font-weight:750;margin:6px 0!important}.status{display:block;width:10px;height:10px;border-radius:50%;background:#c0363f;float:right}.status.ok{background:#2f9e62}.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.facts div{background:#faf7f5;border-radius:10px;padding:12px}.facts dt{color:#776c68;font-size:12px}.facts dd{margin:5px 0 0;font-weight:700}.stack{display:grid;gap:4px}.choices{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.choice{border:1px solid #ddd2cc;border-radius:12px;padding:13px;display:flex;gap:10px;align-items:flex-start}.choice b{display:block}.choice small{color:#776c68}.hint{color:#776c68;font-size:13px;line-height:1.65}label.inline{display:inline-flex;align-items:center;gap:7px;margin:5px 18px 12px 0}input,select,textarea{width:100%;border:1px solid #cfc4be;border-radius:9px;padding:11px;background:#fff;font:inherit}input[type=radio]{width:auto}.field{margin:12px 0}.field label{display:block;font-size:13px;font-weight:700;margin-bottom:6px}.prompt{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.6}.button{display:inline-block;border:0;border-radius:9px;padding:11px 17px;text-decoration:none;background:#5c5654;color:#fff;font:inherit;cursor:pointer}.primary{background:#8b2631}.actions{display:flex;justify-content:flex-end;margin:8px 0 22px}.badge{display:inline-block;border-radius:999px;padding:4px 9px;background:#e5f5eb;color:#17653b;font-size:12px}.badge.warn{background:#fff1cf;color:#895d08}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#7c2630}.log-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.log-view{margin:0;max-height:65vh;overflow:auto;border-radius:10px;background:#171515;color:#ece7e4;padding:16px;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}.success{border-left:5px solid #2f9e62}.error{border-left:5px solid #c0363f}.login{max-width:430px;margin:12vh auto}.login .button{width:100%;margin-top:10px}footer{text-align:center;color:#998e88;font-size:12px;padding:30px}@media(max-width:760px){header{height:auto;padding:14px 18px;align-items:flex-start;gap:12px}nav{flex-wrap:wrap;justify-content:flex-end}.hero{align-items:flex-start;flex-direction:column}.three,.choices,.facts{grid-template-columns:1fr}.hero h1{font-size:28px}main{padding-top:22px}}`

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
	return map[string]string{"pre": "预选", "formal": "正选", "addDrop": "补退选"}[value]
}
func syncStateLabel(value string) string {
	return map[string]string{"never": "尚未运行", "queued": "等待启动", "running": "运行中", "success": "成功", "unchanged": "无变化", "failed": "失败"}[value]
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
