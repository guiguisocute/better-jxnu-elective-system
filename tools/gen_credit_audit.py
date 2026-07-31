#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
毕业核算核对单生成器 —— 输入学号，打印/落档一份「网站口径」的超详细学分明细，
方便给学生逐门核对（含所有选修课明细 + 差额逐项分解）。

复刻 src/lib/studentRecord.deriveInputsFromRecord + creditPlan.buildCreditPlan 的口径。
数据源默认读本地 studentjson/out/*.sql（与 D1 同构）。

用法:
  python tools/gen_credit_audit.py 999999999999            # 打印到 stdout（虚构示例）
  python tools/gen_credit_audit.py 999999999999 -o out.md  # 同时落档
"""
import argparse
import glob
import json
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REQNAT = ["公共必修课", "专业主干", "专业类基础", "教师教育必修"]
REQNAT_RAW = ["公共必修", "专业主干", "专业类基础", "教师教育必修"]
DEFERRED = {"028010": 7}  # 形势与政策：第7学期末结算
CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}


def tidx(label):
    m = re.search(r"第\s*(\d+)\s*学期", label or "")
    if m:
        return int(m.group(1))
    c = re.search(r"第\s*([一二三四五六七八九十]+)\s*学期", label or "")
    return CN.get(c.group(1), 0) if c else 0


def eff(cid, label):
    return DEFERRED.get(cid, tidx(label))


def is_english_offset(name):
    return "大学英语" in name and ("Ⅲ" in name or "Ⅳ" in name)


def load_record(sid):
    pat = re.compile(
        r"INSERT OR REPLACE INTO student_records \(.*?\) VALUES \('" + sid +
        r"', ('[^']*'|NULL), ('[^']*'|NULL), ([^,]+), ([^,]+), '(.*)'\);$")
    for fp in sorted(glob.glob("studentjson/out/student_records_*.sql")):
        for line in open(fp, encoding="utf-8"):
            if line.startswith("INSERT") and f"'{sid}'" in line:
                m = pat.match(line.rstrip("\n"))
                if not m:
                    continue
                plankey = m.group(2)[1:-1] if m.group(2) != "NULL" else None
                rec = json.loads(m.group(5).replace("''", "'"))
                rec["_planKey"] = plankey
                rec["_totalCol"] = m.group(3)
                rec["_takenCol"] = m.group(4)
                return rec
    return None


def elective_label(c, master):
    """选修课的展示归类：nature 优先；nature=None 时看 master tags。"""
    nat = c.get("nature")
    if nat:
        return nat
    tags = (master.get(c.get("courseId"), {}) or {}).get("tags") or []
    if any(t == "公选课" or t.startswith("公选课") for t in tags):
        return "公选课"
    if "专业任选" in tags:
        return "专业任选（非本方案）"
    return "任意选修 / 校外"


def fmt(n):
    n = float(n)
    return str(int(n)) if n.is_integer() else f"{n:.1f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sid")
    ap.add_argument("-o", "--out")
    args = ap.parse_args()
    sid = args.sid

    rec = load_record(sid)
    if not rec:
        sys.exit(f"未在 studentjson/out/*.sql 找到 {sid}")
    pk = rec["_planKey"]
    master = {c["id"]: c for c in json.load(open("data/master/courses.json", encoding="utf-8"))}
    pc = json.load(open("data/master/plan_courses.json", encoding="utf-8")).get(pk, [])
    byc = {c["cid"]: c for c in pc}
    mr = json.load(open("data/master/major_requirements.json", encoding="utf-8"))
    req = next((e for e in mr if f"{e['year']}级-{e['major']}" == pk), None)

    term = rec["readingPlanTerm"]
    plan_term = term + 1
    details = rec["detailCourses"]

    # ---- deriveInputsFromRecord 口径 ----
    taken = set(c["courseId"] for c in details if (c.get("planTermIndex") or 0) <= term and c.get("courseId"))
    raw_missing = [cid for cid in rec.get("requiredCidsUpToReading", []) if cid not in taken and cid not in DEFERRED]
    # 特色课抵大英Ⅲ/Ⅳ
    past = sum(1 for c in details if c.get("nature") == "大学英语特色课" and 0 < (c.get("planTermIndex") or 0) < term)
    cur = sum(1 for c in details if c.get("nature") == "大学英语特色课" and (c.get("planTermIndex") or 0) == term)
    eng_missing = sorted([cid for cid in raw_missing if cid in byc and is_english_offset(byc[cid]["name"])],
                         key=lambda x: eff(x, byc[x]["semester"]))
    covered = set(eng_missing[:past])
    remc = cur
    for cid in eng_missing:
        if remc <= 0:
            break
        if cid in covered:
            continue
        covered.add(cid)
        remc -= 1
    excluded = set(cid for cid in raw_missing if cid not in covered)

    total_earned = 0.0
    elective_this = 0.0
    for c in details:
        pti = c.get("planTermIndex") or 0
        if pti > term:
            continue
        cr = c.get("credits") or 0
        nat = c.get("nature")
        if pti == term:
            is_req = nat is not None and (nat in REQNAT or nat == "大学英语特色课")
            if not is_req:
                elective_this += cr
        else:
            total_earned += cr

    # ---- buildCreditPlan 口径 ----
    required_total = sum((req["byNature"].get(n, {}) or {}).get("sumXf", 0) for n in REQNAT_RAW) if req else 0
    min_total = req["minTotal"] if req else None
    min_me = req["minMajorElective"] if req else 0

    def compute(exclude_set, show_future):
        prev_req = read_req = next_req = 0.0
        next_l, future_l = [], []
        for c in pc:
            if c["nature"] not in REQNAT:
                continue
            ti = eff(c["cid"], c["semester"])
            if ti <= 0 or c["cid"] in exclude_set:
                continue
            if ti <= term - 1:
                prev_req += c["credits"]
            elif ti == term:
                read_req += c["credits"]
            elif ti == plan_term and c["cid"] not in DEFERRED:
                next_req += c["credits"]
                next_l.append(c)
            else:
                future_l.append(c)
        eff_prev = min(prev_req, total_earned)
        req_earned = eff_prev + read_req
        elective_earned = max(0.0, total_earned - eff_prev + elective_this)
        earned_before = req_earned + elective_earned
        proj = next_req
        gap_before = max(0.0, (min_total - earned_before - proj)) if min_total is not None else 0.0
        fut_credits = sum(c["credits"] for c in future_l)
        fut_shown = min(fut_credits, gap_before) if show_future else 0.0
        earned = earned_before + fut_shown
        gap = max(0.0, (min_total - earned - proj)) if min_total is not None else None
        return dict(prev_req=prev_req, read_req=read_req, next_req=next_req, next_l=next_l, future_l=future_l,
                    eff_prev=eff_prev, req_earned=req_earned, elective_earned=elective_earned,
                    earned=earned, proj=proj, gap=gap, fut_shown=fut_shown, fut_credits=fut_credits)

    # 三种口径：默认导入(实习判缺口) / 勾回在读必修(学生实际操作) / 再开「显示未来必修」。
    reading_excluded = {cid for cid in excluded if eff(cid, byc.get(cid, {}).get("semester", "")) == term}
    excluded_checked = excluded - reading_excluded
    sc_default = compute(excluded, False)
    sc_checked = compute(excluded_checked, False)
    sc_future = compute(excluded_checked, True)
    # 主口径用「勾回在读必修」——与学生在引导里把能勾的都勾上后看到的一致。
    M = sc_checked
    eff_prev = M["eff_prev"]; read_req = M["read_req"]; next_req = M["next_req"]
    next_list = M["next_l"]; future_list = M["future_l"]
    req_earned = M["req_earned"]; elective_earned = M["elective_earned"]
    earned = M["earned"]; projection = M["proj"]; gap = M["gap"]
    elective_required = (min_total - required_total) if min_total is not None else None

    taken_me = set(c["courseId"] for c in details if c.get("nature") == "专业限选" and (c.get("planTermIndex") or 0) <= term)
    me_earned = sum(c["credits"] for c in pc if c["nature"] == "专业限选" and c["cid"] in taken_me)

    # ---- 课程按桶分类（展示用） ----
    def bucket(c):
        pti = c.get("planTermIndex") or 0
        if pti == 0:
            return "未知学期"
        if pti < term:
            return "已修"
        if pti == term:
            return "在读"
        if pti == plan_term:
            return "下学期"
        return "未来"

    L = []
    w = L.append
    w(f"# 毕业核算核对单 · {sid}")
    w("")
    w("> 口径 = 本网站「模拟选课·毕业核算」算法（`deriveInputsFromRecord` + `buildCreditPlan`）。")
    w("> 数据为去标识化档案（不含姓名）。学分单位均为「学分」。")
    w("")
    w("## 一、基本信息与毕业要求")
    w("")
    w(f"- 学号：`{sid}`　班级：{rec.get('className') or '—'}　培养方案：**{pk}**")
    w(f"- 在读学期：第 **{term}** 学期；规划（下）学期：第 **{plan_term}** 学期")
    if req:
        w(f"- 毕业最低总学分 **minTotal = {min_total}**　＝　应修必修 **{fmt(required_total)}** ＋ 应修选修 **{fmt(min_total - required_total)}**")
        w(f"- 专业限选硬性子目标：**≥ {min_me}** 学分")
        bn = req["byNature"]
        w("")
        w("  培养方案各性质应修（byNature）：")
        w("")
        w("  | 性质 | 门数 | 应修学分 |")
        w("  |---|---:|---:|")
        for k, v in bn.items():
            w(f"  | {k} | {v.get('count','')} | {v.get('sumXf','')} |")
    w("")
    w("## 二、核算结论与「毕业还差」三种口径")
    w("")
    w("毕业还差取决于**你在引导「核对必修」里勾了哪些在读必修**，三种口径如下：")
    w("")
    w("| 口径 | 在读必修(成绩未出)是否计入 | 未来必修是否计入 | **毕业还差** |")
    w("|---|---|---|---:|")
    w(f"| ① 默认刚导入 | 否（自动判缺口） | 否 | **{fmt(sc_default['gap'])}** |")
    w(f"| ② 勾回在读必修（你的实际操作） | 是 | 否 | **{fmt(sc_checked['gap'])}** |")
    w(f"| ③ 再开「显示未来必修」 | 是 | 是 | **{fmt(sc_future['gap'])}** |")
    w("")
    if reading_excluded:
        rsum = sum(byc.get(cid, {}).get("credits", 0) for cid in reading_excluded)
        names = "、".join(byc.get(cid, {}).get("name", cid) for cid in sorted(reading_excluded))
        w(f"> ①→② 的差额正是 **{fmt(rsum)} 学分在读必修**（{names}）——成绩未出，默认判缺口，你勾回后计入。")
        w("")
    w("下表按**口径②（勾回在读必修）**展开 —— 与你在网站里看到的一致：")
    w("")
    w("| 项 | 学分 | 含义 |")
    w("|---|---:|---|")
    w(f"| 非本学期必修（蓝·已修） | **{fmt(eff_prev)}** | 第1–{term-1}学期已通过必修（封顶在教务总分内）|")
    w(f"| 本学期必修（浅蓝·在读理论） | **{fmt(read_req)}** | 第{term}学期必修，勾回后按理论计入 |")
    w(f"| 选修已修（绿+紫） | **{fmt(elective_earned)}** | 含专业限选 {fmt(me_earned)} |")
    w(f"| **已修合计 earned** | **{fmt(earned)}** | 必修{fmt(req_earned)} + 选修{fmt(elective_earned)} |")
    w(f"| 下学期必修（红·理论投影） | **{fmt(projection)}** | 第{plan_term}学期必修，未修，只作投影 |")
    w(f"| **已修 + 投影** | **{fmt(earned + projection)}** | |")
    if gap is not None:
        w(f"| **毕业还差 totalRemaining** | **{fmt(gap)}** | = max(0, {min_total} − {fmt(earned)} − {fmt(projection)}) |")
    w("")

    # ---- 选修超详细明细 ----
    elec = [c for c in details if c.get("nature") not in REQNAT]
    # 分组：专业限选 / 专业任选 / 教师教育选修 / 大学英语特色课 / 公选课 / 其他
    order = ["专业限选", "专业任选", "教师教育选修", "大学英语特色课", "公选课", "专业任选（非本方案）", "任意选修 / 校外"]
    groups = {}
    for c in elec:
        groups.setdefault(elective_label(c, master), []).append(c)

    w("## 三、选修课超详细明细（逐门核对）")
    w("")
    w("> 网站对「选修已修」用公式 `选修 = (教务总分 − 非本学期必修) + 本学期选修` 整体计算，")
    w("> 并非逐门相加；下表把你实际修过的非必修课全列出来，方便你逐门核对**漏没漏、性质对不对**。")
    w("")
    grand = 0.0
    for g in order + [k for k in groups if k not in order]:
        rows = groups.get(g)
        if not rows:
            continue
        rows.sort(key=lambda c: (c.get("planTermIndex") or 0, c.get("courseId") or ""))
        sub = sum(c.get("credits") or 0 for c in rows)
        grand += sub
        w(f"### {g}　·　{len(rows)} 门 / {fmt(sub)} 学分")
        w("")
        w("| 课程号 | 课程名 | 学分 | 学期(修读) | 状态 |")
        w("|---|---|---:|---|---|")
        for c in rows:
            w(f"| `{c.get('courseId')}` | {c.get('courseName')} | {fmt(c.get('credits') or 0)} | {c.get('semester') or '—'} | {bucket(c)} |")
        w("")
    w(f"**选修课总计（含在读/下学期/未来，未扣口径）：{fmt(grand)} 学分**")
    w("")
    w(f"- 其中**专业限选**已修 **{fmt(me_earned)} / {min_me}**（{'已达标' if me_earned >= min_me else '未达标'}）。")
    w(f"- 网站口径「选修已修」= **{fmt(elective_earned)}** / 应修 **{fmt(elective_required)}**"
      + (f"，**还差 {fmt(elective_required - elective_earned)}**" if elective_required and elective_required > elective_earned else "，已达标") + "。")
    w("")

    # ---- 必修明细 ----
    w("## 四、必修明细")
    w("")
    req_taken = [c for c in details if c.get("nature") in REQNAT and (c.get("planTermIndex") or 0) <= term]
    req_taken.sort(key=lambda c: (c.get("planTermIndex") or 0, c.get("courseId") or ""))
    w(f"### 已修 / 在读必修（共 {len(req_taken)} 门，{fmt(sum(c.get('credits') or 0 for c in req_taken))} 学分；网站封顶计入 {fmt(eff_prev + read_req)}）")
    w("")
    w("| 课程号 | 课程名 | 学分 | 性质 | 学期 | 状态 |")
    w("|---|---|---:|---|---|---|")
    for c in req_taken:
        w(f"| `{c.get('courseId')}` | {c.get('courseName')} | {fmt(c.get('credits') or 0)} | {c.get('nature')} | {c.get('semester') or '—'} | {bucket(c)} |")
    w("")
    if excluded:
        w(f"### ⚠ 被判为「缺口」的必修（{len(excluded)} 门）—— 档案里没有、成绩未出或未修")
        w("")
        w("| 课程号 | 课程名 | 学分 | 性质 | 方案学期 | 说明 |")
        w("|---|---|---:|---|---|---|")
        for cid in sorted(excluded, key=lambda x: eff(x, byc.get(x, {}).get("semester", ""))):
            c = byc.get(cid, {})
            note = "在读·成绩未出，引导里可勾回计入" if eff(cid, c.get("semester", "")) == term else "未修"
            w(f"| `{cid}` | {c.get('name','?')} | {fmt(c.get('credits',0))} | {c.get('nature')} | {c.get('semester')} | {note} |")
        w("")
    # 下学期必修
    w(f"### 下学期必修（第{plan_term}学期，红色理论投影 {fmt(next_req)} 学分）")
    w("")
    w("| 课程号 | 课程名 | 学分 | 性质 |")
    w("|---|---|---:|---|")
    for c in sorted(next_list, key=lambda c: c["cid"]):
        w(f"| `{c['cid']}` | {c['name']} | {fmt(c['credits'])} | {c['nature']} |")
    w("")
    # 未来必修
    if future_list:
        fut_sum = sum(c["credits"] for c in future_list)
        w(f"### 未来必修（第{plan_term+1}学期及之后 / 延迟结算，{fmt(fut_sum)} 学分）—— 默认**不计入已修**")
        w("")
        w("| 课程号 | 课程名 | 学分 | 性质 | 方案学期 | 备注 |")
        w("|---|---|---:|---|---|---|")
        for c in sorted(future_list, key=lambda c: eff(c["cid"], c["semester"])):
            note = "延迟结算（第7学期末才出成绩）" if c["cid"] in DEFERRED else ""
            w(f"| `{c['cid']}` | {c['name']} | {fmt(c['credits'])} | {c['nature']} | {c['semester']} | {note} |")
        w("")
        w("> 打开引导里的「显示未来必修」开关后，这部分会按浅蓝规划计入，毕业还差会相应减少。")
        w("")

    # ---- 差额逐项 ----
    if gap is not None and gap > 0:
        w("## 五、毕业还差逐项分解")
        w("")
        w(f"已修 {fmt(earned)} + 下学期投影 {fmt(projection)} = {fmt(earned + projection)}，距 {min_total} 还差 **{fmt(gap)}**，由这几项构成：")
        w("")
        fut_sum = sum(c["credits"] for c in future_list)
        elec_gap = max(0.0, (elective_required or 0) - elective_earned)
        w("| 缺口项 | 学分 | 性质 |")
        w("|---|---:|---|")
        for c in sorted(future_list, key=lambda c: eff(c["cid"], c["semester"])):
            note = "延迟结算必修" if c["cid"] in DEFERRED else "未来学期必修"
            w(f"| {c['name']} (`{c['cid']}`) | {fmt(c['credits'])} | {note} |")
        if elec_gap > 0:
            w(f"| 选修学分缺口 | {fmt(elec_gap)} | 选修 {fmt(elective_earned)}/{fmt(elective_required)} |")
        w(f"| **合计** | **{fmt(fut_sum + elec_gap)}** | |")
        w("")

    doc = "\n".join(L)
    print(doc)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(doc + "\n")
        print(f"\n[已落档] {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
