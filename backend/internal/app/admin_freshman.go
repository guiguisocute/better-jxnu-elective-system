package app

import (
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 新生嗅探的面板入口。放首页而不是「自动构建」页：它是一年一次、需要人盯着
// 「出数据了没有」的守候，和每小时跑的构建 timer 不是一类东西。

var freshmanStateMeta = map[string]struct{ Class, Label string }{
	"idle":    {"hint", "未运行"},
	"running": {"badge warn", "扫描中"},
	"waiting": {"badge warn", "还没出数据"},
	"found":   {"badge", "已出数据"},
	"failed":  {"badge err", "失败"},
}

func (a *AdminServer) freshmanCard(session adminSession, cfg RuntimeConfig) string {
	state := a.freshman.Status()
	var b strings.Builder
	b.WriteString(`<section class="card"><h2>新生嗅探（学号名单 / 培养方案）</h2>`)
	b.WriteString(`<p class="hint">每年新生的<b>学号名单</b>和<b>培养方案</b>由教务分批放出，没有任何通知。开着它就会定期去看一眼，出数据了在这里显示。<b>定时任务只做检查，绝不自动写库</b>——入库永远是你手动点一下。</p>`)

	b.WriteString(`<form method="post" action="/action/save-freshman" class="stack">` + csrf(session))
	b.WriteString(`<div class="grid three">`)
	b.WriteString(`<div class="field"><label>盯哪一届（入学年份）</label><input name="freshmanGrade" value="` +
		template.HTMLEscapeString(cfg.FreshmanGrade) + `" placeholder="例如 2026" pattern="20\d{2}"><p class="hint">留空表示不启用。班级名里的「26级」由它推出。</p></div>`)
	b.WriteString(`<div class="field"><label>检查间隔（小时）</label><input type="number" name="freshmanWatchIntervalHours" value="` +
		strconv.Itoa(cfg.FreshmanWatchIntervalHours) + `" min="1" max="168"></div>`)
	b.WriteString(`<div class="field"><label>开关</label><label class="inline"><input type="checkbox" name="freshmanRosterWatchEnabled" ` +
		checked(cfg.FreshmanRosterWatchEnabled) + `> 学号名单</label><label class="inline"><input type="checkbox" name="freshmanPlanWatchEnabled" ` +
		checked(cfg.FreshmanPlanWatchEnabled) + `> 培养方案</label></div>`)
	b.WriteString(`</div><button class="button" type="submit">保存嗅探设置</button></form>`)

	b.WriteString(`<div class="grid two">`)
	b.WriteString(a.freshmanProbeBlock(session, "roster", "学号名单", state.Roster, cfg))
	b.WriteString(a.freshmanProbeBlock(session, "plan", "培养方案", state.Plan, cfg))
	b.WriteString(`</div></section>`)
	return b.String()
}

func (a *AdminServer) freshmanProbeBlock(session adminSession, target, title string, probe FreshmanProbe, cfg RuntimeConfig) string {
	meta, ok := freshmanStateMeta[probe.State]
	if !ok {
		meta = freshmanStateMeta["idle"]
	}
	var b strings.Builder
	b.WriteString(`<div class="report-item"><h3 style="margin:0 0 8px;font-size:15px">` + title + ` <span class="` + meta.Class + `">` + meta.Label + `</span></h3>`)
	b.WriteString(`<p class="hint">` + template.HTMLEscapeString(emptyDash(probe.Message)) + `</p>`)

	facts := fmt.Sprintf(`<dl class="facts"><div><dt>已扫</dt><dd>%d / %d</dd></div><div><dt>抓到</dt><dd>%d</dd></div><div><dt>上次检查</dt><dd>%s</dd></div><div><dt>首次出数据</dt><dd>%s</dd></div></dl>`,
		probe.Scanned, probe.Total, probe.Found, localTimeLabel(probe.LastCheckedAt), localTimeLabel(probe.LastFoundAt))
	b.WriteString(facts)

	if probe.LastError != "" {
		b.WriteString(`<p class="hint">最近一条错误：` + template.HTMLEscapeString(truncateRunes(probe.LastError, 200)) + `</p>`)
	}
	if len(probe.Highlights) > 0 {
		items := probe.Highlights
		if len(items) > 8 {
			items = items[:8]
		}
		b.WriteString(`<p class="hint">` + template.HTMLEscapeString(strings.Join(items, " · ")) + `</p>`)
	}

	disabled := ""
	if cfg.FreshmanGrade == "" || probe.State == "running" {
		disabled = " disabled"
	}
	b.WriteString(`<div class="action-row">`)
	b.WriteString(`<form method="post" action="/action/freshman-check">` + csrf(session) +
		`<input type="hidden" name="target" value="` + target + `"><button class="button" type="submit"` + disabled + `>快速检查</button></form>`)
	b.WriteString(`<form method="post" action="/action/freshman-check">` + csrf(session) +
		`<input type="hidden" name="target" value="` + target + `"><input type="hidden" name="full" value="1"><button class="button" type="submit"` + disabled + `>全量抓取</button></form>`)
	if target == "roster" {
		importDisabled := ""
		if probe.SnapshotPath == "" || probe.State == "running" {
			importDisabled = " disabled"
		}
		b.WriteString(`<form method="post" action="/action/freshman-import" onsubmit="return confirm('把这一届新生学号写入 student_records？已有快照的学号不会被覆盖。')">` + csrf(session) +
			`<button class="button primary" type="submit"` + importDisabled + `>一键入库</button></form>`)
	}
	b.WriteString(`</div>`)
	if target == "roster" && probe.Imported > 0 {
		b.WriteString(`<p class="hint">上次入库：` + localTimeLabel(probe.ImportedAt) + ` · ` + strconv.Itoa(probe.Imported) + ` 行</p>`)
	}
	if target == "plan" {
		b.WriteString(`<p class="hint">培养方案只做<b>监测</b>：抓到的是「哪些专业已经有课程、看着齐不齐」的摘要。真正并入 <code>training_plan.json</code> 仍是离线构建的事（v9 结构还需要毕业学分等页面外字段）。</p>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

func localTimeLabel(value string) string {
	if value == "" {
		return "—"
	}
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	return at.Local().Format("01-02 15:04")
}

func (a *AdminServer) saveFreshman(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	cfg := a.config.Get()
	cfg.FreshmanGrade = strings.TrimSpace(r.Form.Get("freshmanGrade"))
	cfg.FreshmanRosterWatchEnabled = r.Form.Get("freshmanRosterWatchEnabled") == "on"
	cfg.FreshmanPlanWatchEnabled = r.Form.Get("freshmanPlanWatchEnabled") == "on"
	hours, err := strconv.Atoi(strings.TrimSpace(r.Form.Get("freshmanWatchIntervalHours")))
	if err != nil {
		a.result(w, "保存失败", "检查间隔必须是整数小时", false, &session)
		return
	}
	cfg.FreshmanWatchIntervalHours = hours
	if err := a.config.Save(cfg); err != nil {
		a.result(w, "保存失败", err.Error(), false, &session)
		return
	}
	a.audit(r.Context(), r, auditEntry{
		Action: auditFreshman, Target: cfg.FreshmanGrade,
		Detail: fmt.Sprintf("新生嗅探设置：学号名单=%v，培养方案=%v，间隔 %d 小时。", cfg.FreshmanRosterWatchEnabled, cfg.FreshmanPlanWatchEnabled, hours),
	})
	a.result(w, "嗅探设置已保存", "下一次轮询会读取新设置；也可以直接点「快速检查」立刻看一眼。", true, &session)
}

func (a *AdminServer) checkFreshman(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	target := r.Form.Get("target")
	full := r.Form.Get("full") == "1"
	if err := a.freshman.Start(target, full); err != nil {
		a.result(w, "启动失败", err.Error(), false, &session)
		return
	}
	scope := "快速检查"
	if full {
		scope = "全量抓取"
	}
	a.audit(r.Context(), r, auditEntry{Action: auditFreshman, Target: target, Detail: "手动启动新生嗅探：" + scope + "。"})
	a.result(w, scope+"已启动", "在后台运行，回总览页刷新即可看到进度。全量抓取可能要几分钟。", true, &session)
}

func (a *AdminServer) importFreshman(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	written, err := a.freshman.ImportRoster(r.Context())
	if err != nil {
		a.result(w, "入库失败", err.Error(), false, &session)
		return
	}
	a.audit(r.Context(), r, auditEntry{
		Action: auditFreshman, Target: "import",
		Detail: fmt.Sprintf("把新生学号写入 student_records，共 %d 行（已存在的学号未覆盖）。", written),
	})
	a.result(w, "入库完成", fmt.Sprintf("写入 %d 行占位记录。他们现在已经能被查到；课表会在下一次「固化学期」时补上。", written), true, &session)
}
