package app

import (
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"strings"
)

// 固化学期的面板入口。放在首页而不是「自动构建」页，因为它是每学期只做一次、
// 需要盯一会儿的人工动作，不是自动化任务。

var finalizeStateMeta = map[string]struct{ Class, Label string }{
	"idle":      {"hint", "未运行"},
	"running":   {"badge warn", "运行中"},
	"paused":    {"badge warn", "已暂停"},
	"done":      {"badge", "已完成"},
	"failed":    {"badge err", "失败"},
	"cancelled": {"badge warn", "已取消"},
}

// finalizeCard renders the batch's status and controls.
func (a *AdminServer) finalizeCard(session adminSession, cfg RuntimeConfig, terms []string) string {
	state := a.finalize.Status()
	meta, ok := finalizeStateMeta[state.State]
	if !ok {
		meta = finalizeStateMeta["idle"]
	}

	target := state.TargetTerm
	if target == "" {
		// Default to the term the operator most likely wants to freeze: the one
		// right before whatever 教务 currently calls the planning term.
		target = cfg.FinalizedTerm
	}

	var b strings.Builder
	b.WriteString(`<section class="card"><h2>固化学期（全量刷新学号快照）</h2>`)
	b.WriteString(`<p><span class="` + meta.Class + `">` + meta.Label + `</span> ` +
		template.HTMLEscapeString(state.Message) + `</p>`)
	b.WriteString(`<p class="hint">把全校学生的课表快照刷成「某个已结束学期为止」的最终版，每学期<b>补退选结束、成绩出完后</b>做一次即可。注意：学号查询本身走实时链路，<b>学分数字不依赖这个任务</b>；它保的是教务/VPS 不可用时前台读的那份兜底快照。</p>`)

	if state.Total > 0 || state.Processed > 0 {
		percent := 0
		if state.Total > 0 {
			percent = state.Processed * 100 / state.Total
		}
		b.WriteString(fmt.Sprintf(`<dl class="facts four"><div><dt>进度</dt><dd>%d / %d（%d%%）</dd></div><div><dt>已更新</dt><dd>%d</dd></div><div><dt>跳过</dt><dd>%d</dd></div><div><dt>失败</dt><dd>%d</dd></div><div><dt>目标学期</dt><dd>%s</dd></div></dl>`,
			state.Processed, state.Total, percent, state.Updated, state.Skipped, state.Failed, template.HTMLEscapeString(emptyDash(state.TargetTerm))))
		details := []string{}
		if state.LastStudent != "" {
			details = append(details, "最近处理 "+truncateRunes(state.LastStudent, 4)+"****（耗时 "+state.LastDuration+"）")
		}
		if state.Cursor != "" {
			details = append(details, "断点 "+truncateRunes(state.Cursor, 4)+"****")
		}
		if state.SmokeTest {
			details = append(details, "本次为冒烟测试，不会改动「已结束学期」设置")
		}
		if len(details) > 0 {
			b.WriteString(`<p class="hint">` + template.HTMLEscapeString(strings.Join(details, " · ")) + `</p>`)
		}
		if state.LastError != "" {
			b.WriteString(`<p class="hint">最近一条错误：` + template.HTMLEscapeString(truncateRunes(state.LastError, 200)) + `</p>`)
		}
	}

	if state.State == "running" {
		b.WriteString(`<div class="action-row">`)
		b.WriteString(`<form method="post" action="/action/finalize-pause">` + csrf(session) + `<button class="button" type="submit">暂停（可续跑）</button></form>`)
		b.WriteString(`<form method="post" action="/action/finalize-cancel" onsubmit="return confirm('确定取消？进度会保留，可从断点继续。')">` + csrf(session) + `<button class="button" type="submit" style="background:#8b2631">取消</button></form>`)
		b.WriteString(`</div></section>`)
		return b.String()
	}

	resumable := state.Cursor != "" && (state.State == "paused" || state.State == "cancelled" || state.State == "failed")
	b.WriteString(`<form method="post" action="/action/finalize-start" class="stack">` + csrf(session))
	b.WriteString(`<div class="grid three">`)
	b.WriteString(`<div class="field"><label>要固化到哪个学期</label><input name="targetTerm" list="term-options" value="` +
		template.HTMLEscapeString(target) + `" placeholder="例如 25-26第2学期" required><p class="hint">必须是<b>已经结束、成绩已出</b>的学期。</p></div>`)
	b.WriteString(`<div class="field"><label>冒烟测试人数（0 = 全量）</label><input type="number" name="limit" value="10" min="0" max="30000"><p class="hint">先用 10 人验证整条链路，再改成 0 跑全量。</p></div>`)
	b.WriteString(`<div class="field"><label>每人间隔（毫秒）</label><input type="number" name="delayMs" value="` +
		strconv.Itoa(defaultFinalizeDelayMs(state.DelayMs)) + `" min="200" max="60000"><p class="hint">保护教务服务器。单人本身约 1.5s，28818 人全量约 12~16 小时。</p></div>`)
	b.WriteString(`</div>`)
	if resumable {
		b.WriteString(`<label class="inline"><input type="checkbox" name="resume" checked>从断点继续（不勾选则从头开始）</label>`)
	}
	b.WriteString(`<button class="button primary" type="submit">开始固化</button></form>`)
	b.WriteString(`<datalist id="term-options">` + options(terms, target) + `</datalist>`)
	b.WriteString(`</section>`)
	return b.String()
}

func defaultFinalizeDelayMs(stored int) int {
	if stored >= 200 && stored <= 60000 {
		return stored
	}
	return int(finalizeDefaultDelay / 1e6)
}

func (a *AdminServer) startFinalize(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	targetTerm := strings.TrimSpace(r.Form.Get("targetTerm"))
	limit, _ := strconv.Atoi(strings.TrimSpace(r.Form.Get("limit")))
	delayMs, err := strconv.Atoi(strings.TrimSpace(r.Form.Get("delayMs")))
	if err != nil {
		a.result(w, "启动失败", "每人间隔必须是整数毫秒", false, &session)
		return
	}
	if limit < 0 {
		a.result(w, "启动失败", "冒烟测试人数不能为负", false, &session)
		return
	}
	resume := r.Form.Get("resume") == "on"
	if err := a.finalize.Start(targetTerm, limit, delayMs, resume); err != nil {
		a.result(w, "启动失败", err.Error(), false, &session)
		return
	}
	scope := "全量"
	if limit > 0 {
		scope = fmt.Sprintf("冒烟测试 %d 人", limit)
	}
	a.audit(r.Context(), r, auditEntry{
		Action: auditFinalize, Target: targetTerm,
		Detail: fmt.Sprintf("启动固化学期 %s（%s，间隔 %dms，断点续跑=%v）。", targetTerm, scope, delayMs, resume),
	})
	a.result(w, "固化已启动", scope+"已在后台运行，可回总览页查看进度；期间可以暂停或取消，进度会保留。", true, &session)
}

func (a *AdminServer) pauseFinalize(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	if err := a.finalize.Pause(); err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}
	a.result(w, "已请求暂停", "当前这名学生处理完后会停下，进度保留，可从断点继续。", true, &session)
}

func (a *AdminServer) cancelFinalize(w http.ResponseWriter, r *http.Request, session adminSession) {
	if !a.validPost(w, r, session) {
		return
	}
	if err := a.finalize.Cancel(); err != nil {
		a.result(w, "操作失败", err.Error(), false, &session)
		return
	}
	a.audit(r.Context(), r, auditEntry{Action: auditFinalize, Target: "cancel", Detail: "取消了固化学期任务。"})
	a.result(w, "已取消", "进度已保留，可从断点继续。", true, &session)
}
