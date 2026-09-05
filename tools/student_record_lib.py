"""
学生档案联表核心 —— 「per 学生聚合数据 → record_json」的纯映射逻辑。

从 build_student_records.py 抽出，供两处复用、保证口径一致：
  - build_student_records.py  离线全校批量（studentjson 8 份快照 union → D1 SQL）
  - tools/jwc_schedule.py + ~/apps/jxnu-live 实时抓取（教务 Xfz_Kcb 全学期 → 同形状 JSON）

不含任何抓取/IO/SQL 逻辑；build_record 是纯函数。改这里 = 两侧口径同步变。

**线上实时链路已经不是这里了**：VPS 常驻的是 Go 的 jxnu-backend
（`backend/internal/app/records.go: BuildStudentRecord`），学号查询和固化学期都走它。
本文件只剩离线构建 studentjson 快照这一条路。两边有一处**已知不对齐**：Go 侧多了
面板配置「已结束学期」派生的 `earnedThroughTerm`（成绩已出的学期整体计入已修，并随
record 发给前端），这里没有配置来源，所以仍是「整个在读学期不计」的旧口径。用本文件
重灌 D1 会把那批快照打回旧口径 —— 但实时链路每次查询都会重算并覆盖回写，所以影响
只在教务/VPS 不可用的兜底那一刻。
"""

import json
import os
import re


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ============ className → planKey ============

# 全角化（半角括号→全角，方便统一匹配 mr/pc 的 planKey 形态）。
def to_full_paren(s):
    return (s or "").replace("(", "（").replace(")", "）")


# 提取「N班」及后缀括号。返回 (body, suffix_paren or "")
_class_tail_re = re.compile(r"(\d+)?班\s*(?:（([^）]*)）)?\s*$")


def parse_classname(cn):
    """className → (year, body, mid_paren, tail_paren)；不可解析返回 None。"""
    if not cn:
        return None
    cn = to_full_paren(cn.strip())
    m = re.match(r"^(\d{2})级", cn)
    if not m:
        return None
    yr = 2000 + int(m.group(1))
    rest = cn[m.end():]
    tail = _class_tail_re.search(rest)
    if not tail:
        return None
    tail_paren = tail.group(2) or ""
    body_full = rest[: tail.start()].strip()
    # 体内中段括号（如「环境设计（室内设计）」「计算机科学与技术（师范）」）
    mid_paren = ""
    mid_m = re.search(r"（([^）]*)）", body_full)
    if mid_m:
        mid_paren = mid_m.group(1)
    body_clean = re.sub(r"（[^）]*）", "", body_full).strip()
    return yr, body_clean, mid_paren, tail_paren


# 特殊通识必修白名单：不进常规周课表、但全员必修且默认已修（如红色文化/劳动教育概论）。
# 规则：方案要求(ti<=在读)且学生档案里没出现 → 补算为已修，确保已修学分不漏算。
SPECIAL_CREDIT_CIDS = {"028021", "028022", "028023", "028020", "024001"}  # 红色文化 / 劳动教育概论 / 劳动教育概论（实践）/ 思政实践课 / 毕业设计（论文）/

# 师范类修饰词（班级名出现这些 → 优先师范变体）。
_SHIFAN_HINTS = ["公费师范生", "国家公费师范生", "公费师范", "师范"]
# 非师范专业的"普通班"默认变体优先级 —— 班级名无修饰时优先猜这些（综合型最通用）。
_NONSHIFAN_DEFAULTS = ["综合型", "学术型", "普通", "非师范"]


def classname_to_plankey_candidates(cn, valid_keys):
    """
    返回按优先级排序的候选 planKey（已与 valid_keys 求交）。弱匹配：班级名与方案不对称是常态，
    宁可不瞎猜师范——非师范班级名优先「综合型」等普通变体，师范变体仅在班级名含「师范」字样时优先，
    否则降到最末兜底（仅当该专业只有师范变体时才用）。猜错由前端「识别错误?点击修改」兜底。
    """
    parsed = parse_classname(cn)
    if not parsed:
        return []
    yr, body, mid, tail = parsed
    prefix = f"{yr}级-"
    is_shifan_class = any(h in (tail or "") or h in (mid or "") for h in _SHIFAN_HINTS)

    candidates = []

    def add(major):
        if not major:
            return
        key = prefix + major
        if key in valid_keys and key not in candidates:
            candidates.append(key)

    # 1) 干净主体精确匹配（无修饰）
    add(body)
    # 2) 班级名自带括号修饰（中段/尾缀全名，如 "环境设计（室内设计）"）
    if mid:
        add(f"{body}（{mid}）")
    if tail:
        add(f"{body}（{tail}）")
    # 3) 班级名含师范字样 → 优先师范变体
    if is_shifan_class:
        for v in _SHIFAN_HINTS:
            add(f"{body}（{v}）")
    # 4) 普通班默认：综合型 > 学术型 > …（非师范优先，修掉"无修饰被错配师范"）
    for v in _NONSHIFAN_DEFAULTS:
        add(f"{body}（{v}）")
    # 5) 最末兜底师范：仅当该专业只有师范变体（多见于纯师范专业）
    if not is_shifan_class:
        for v in _SHIFAN_HINTS:
            add(f"{body}（{v}）")

    return candidates


def classname_to_plankey(cn, valid_keys):
    cands = classname_to_plankey_candidates(cn, valid_keys)
    return cands[0] if cands else None


# ============ schedule 字段拼成 "星期X-第N节" / "第MN节" ============

def fmt_period(start, end):
    try:
        s = int(start)
    except (TypeError, ValueError):
        return ""
    try:
        e = int(end) if end is not None else s
    except (TypeError, ValueError):
        e = s
    if e < s:
        s, e = e, s
    if e == s:
        return f"第{s}节"
    # 枚举区间内每一节再拼接，parseSchedule 按 1[0-2]|[1-9] 切分：
    # 第89节→8,9；第345节→3,4,5（区间端点不相邻时也能展开中间节次）。
    body = "".join(str(p) for p in range(s, e + 1))
    return f"第{body}节"


def fmt_schedule(item):
    day = (item.get("dayLabel") or "").strip()
    pd = fmt_period(item.get("startPeriod"), item.get("endPeriod"))
    if day and pd:
        return f"{day}-{pd}"
    return day or pd


# ============ 培养方案学期推算（复刻 src/lib/term.ts） ============
# 与 creditPlan.ts 的 REQUIRED_NATURES 对齐（plan_courses 的 nature 已归一化）。
REQUIRED_NATURES = ["公共必修课", "专业主干", "专业类基础", "教师教育必修"]
_CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}


def enroll_year_of(plan_key, class_name):
    """入学年：优先 planKey 的 4 位，其次 className 的 2 位前缀。取不到 None。"""
    if plan_key:
        m = re.search(r"(\d{4})", plan_key)
        if m:
            return int(m.group(1))
    if class_name:
        m = re.match(r"^\s*(\d{2})", class_name)
        if m:
            return 2000 + int(m.group(1))
    return None


def parse_student_sem(label):
    """学生学期 "25-26第2学期" → (year, season)。第1学期=前一年秋，第2学期=后一年春。取不到 None。"""
    if not label:
        return None
    m = re.search(r"(\d{2})-(\d{2})第(\d+)学期", label)
    if not m:
        return None
    y1, y2, n = 2000 + int(m.group(1)), 2000 + int(m.group(2)), int(m.group(3))
    return (y1, "秋") if n % 2 == 1 else (y2, "春")


def plan_term_from_cal(enroll_y, cal):
    """复刻 currentPlanTerm：秋=(year-enrollY)*2+1；春=(year-1-enrollY)*2+2。无效返回 0。"""
    if enroll_y is None or not cal:
        return 0
    year, season = cal
    cur = (year - enroll_y) * 2 + 1 if season == "秋" else (year - 1 - enroll_y) * 2 + 2
    return max(1, cur)


def previous_cal_term(cal):
    """规划快照学期 → 当下在读学期。秋季规划的前一学期是同年春，春季规划的前一学期是上年秋。"""
    if not cal:
        return None
    year, season = cal
    return (year, "春") if season == "秋" else (year - 1, "秋")


def cal_term_key(cal):
    """(year, 春/秋) → 前端统一学期 key YYYY-03 / YYYY-09。"""
    if not cal:
        return ""
    year, season = cal
    return f"{year}-{'03' if season == '春' else '09'}"


def cn_term_index(label):
    """plan_courses 的 "第N学期"/"第十学期" → N；取不到 0。复刻 termIndexOf。"""
    if not label:
        return 0
    m = re.search(r"第\s*(\d+)\s*学期", label)
    if m:
        return int(m.group(1))
    m2 = re.search(r"第\s*([一二三四五六七八九十]+)\s*学期", label)
    if m2 and m2.group(1) in _CN_NUM:
        return _CN_NUM[m2.group(1)]
    return 0


# ============ master 上下文 ============

def load_master_ctx(master_dir=os.path.join("data", "master")):
    """载入 record 构建所需的 master 派生表。返回 dict，供 build_record 复用。

    - credit_of: courseNo → credits
    - english_feature_cids: 全局标记为「大学英语特色课」的 cid（方案 nature 缺失时兜底）
    - valid_keys: 合法 planKey 集合（plan_courses ∪ major_requirements）
    - pc_map: planKey → PlanCourse[]
    """
    master = load_json(os.path.join(master_dir, "courses.json"))
    credit_of = {str(c.get("id", "")): c.get("credits") for c in master if c.get("id")}
    # 大学英语特色课的全局标记（master tags）。学生可能选了不在本专业「特色课菜单」里的特色课
    # （如批判性阅读Ⅰ：方案只列第4学期那几门，第3学期选的就不在 plan_courses 里），此时
    # 方案 nature 缺失 → 前端「特色课 1:1 抵大英Ⅲ/Ⅳ」漏算 → 大英Ⅳ不自动勾选。靠全局 tag 兜底。
    english_feature_cids = {
        str(c.get("id", "")) for c in master
        if c.get("id") and "大学英语特色课" in (c.get("tags") or [])
    }

    pc = load_json(os.path.join(master_dir, "plan_courses.json"))
    mr = load_json(os.path.join(master_dir, "major_requirements.json"))
    valid_keys = set(pc.keys() if isinstance(pc, dict) else [])
    for e in mr if isinstance(mr, list) else []:
        y, mj = e.get("year"), e.get("major")
        if y and mj:
            valid_keys.add(f"{y}级-{mj}")
    pc_map = pc if isinstance(pc, dict) else {}

    return {
        "credit_of": credit_of,
        "english_feature_cids": english_feature_cids,
        "valid_keys": valid_keys,
        "pc_map": pc_map,
    }


# ============ per 学生 → record ============

def build_record(sid, class_name, courses_by_cno, latest_term, schedule_items, no_schedule, ctx):
    """把一名学生的聚合数据映射成最终 row + record_json（纯函数）。

    入参：
      sid            学号
      class_name     最新一份见到的班级名
      courses_by_cno OrderedDict[courseNo] -> {courseName, teacher, teachingClass, semester(最早出现的 termLabel)}
                     —— 插入顺序即 detailCourses 输出顺序，两侧须一致以保证幂等。
      latest_term    最新快照/规划学期 label（如 "26-27第1学期"）
      schedule_items 规划学期的原始 scheduleItems（周课表解析结果；无则 []）
      no_schedule    True = 该生本学期确认无课表
      ctx            load_master_ctx() 的返回

    返回 dict：
      row              {student_id, class_name, plan_key, total_earned, taken_count, record_json(JSON字符串)}
      record           record_json 的 dict 形态（实时服务直接用，免二次 parse）
      plan_key         命中的 planKey（None = 未命中）
      missing_credits  本次遇到的缺学分 courseNo 集合（调用方汇总用）
    """
    credit_of = ctx["credit_of"]
    english_feature_cids = ctx["english_feature_cids"]
    valid_keys = ctx["valid_keys"]
    pc_map = ctx["pc_map"]
    missing_credits = set()

    # 0) className → planKey + 入学年 + 在读培养方案学期 + 该方案 nature/必修全集。
    # 最新快照代表“本次要规划/选课的学期”，不是当前在读学期：
    # 26-27第1学期 = 2026-09 规划目标，因此在读仍是它前一学期 2026-03。
    plan_key = classname_to_plankey(class_name, valid_keys)
    enroll_y = enroll_year_of(plan_key, class_name)
    planning_cal = parse_student_sem(latest_term)
    planning_semester = cal_term_key(planning_cal)
    reading_plan_term = plan_term_from_cal(enroll_y, previous_cal_term(planning_cal))
    plan_courses_list = pc_map.get(plan_key) or []
    nature_of = {c["cid"]: c["nature"] for c in plan_courses_list}
    required_up_to_reading = []
    if reading_plan_term > 0:
        for c in plan_courses_list:
            if c["nature"] in REQUIRED_NATURES and 0 < cn_term_index(c["semester"]) <= reading_plan_term:
                required_up_to_reading.append(c["cid"])

    # 1) detailCourses 联学分 + nature + planTermIndex
    detail_out = []
    total_earned = 0.0
    for cno, info in courses_by_cno.items():
        credits = credit_of.get(cno)
        if credits is None:
            missing_credits.add(cno)
            credits = 0
        pti = plan_term_from_cal(enroll_y, parse_student_sem(info["semester"]))
        detail_out.append({
            "courseId": cno,
            "courseName": info["courseName"],
            "credits": credits,
            "semester": info["semester"] or None,
            "planTermIndex": pti,
            # 方案 nature 优先；方案没列但全局标记是特色课的，兜底为「大学英语特色课」。
            "nature": nature_of.get(cno) or ("大学英语特色课" if cno in english_feature_cids else None),
            "teacher": info["teacher"] or None,
            "teachingClass": info["teachingClass"] or None,
        })
        # 教务总学分不含当前在读学期，更不能把规划学期的预排课程算成已修。
        # 学期未知(pti=0)的历史课沿用旧行为计入，避免无标签旧数据被整体漏算。
        if reading_plan_term <= 0 or pti == 0 or pti < reading_plan_term:
            try:
                total_earned += float(credits)
            except (TypeError, ValueError):
                pass

    # 1b) 特殊通识必修补算（红色文化/劳动教育概论等不进课表的全员必修）：
    #     方案要求(ti<=在读)且档案里没有 → 补进 detailCourses 视为已修，避免漏算学分。
    if reading_plan_term > 0:
        existing = set(courses_by_cno.keys())
        for c in plan_courses_list:
            cid = c["cid"]
            if cid not in SPECIAL_CREDIT_CIDS or cid in existing:
                continue
            ti = cn_term_index(c["semester"])
            if not (0 < ti <= reading_plan_term):
                continue
            cr = credit_of.get(cid)
            if cr is None:
                cr = c.get("credits") or 0
            detail_out.append({
                "courseId": cid,
                "courseName": c["name"],
                "credits": cr,
                "semester": None,
                "planTermIndex": ti,
                "nature": c["nature"],
                "teacher": None,
                "teachingClass": None,
                "supplemented": True,  # 标记：白名单补算，非课表来源
            })
            try:
                total_earned += float(cr)
            except (TypeError, ValueError):
                pass

    # 2) scheduleItems 形态对齐 StudentScheduleItem
    schedule_out = []
    for item in schedule_items:
        cno = str(item.get("courseNo") or "").strip()
        schedule_out.append({
            "courseId": cno,
            "courseName": str(item.get("courseName") or "").strip(),
            "teacher": str(item.get("teacher") or "").strip() or None,
            # 教学班名（如「合班吴郁琴.2班」）：与 formal_sections.className 同口径，
            # 是校对真实班级的最权威依据（同教师/同时段的合班只能靠它区分）。
            "className": str(item.get("teachingClass") or "").strip() or None,
            "classroom": str(item.get("location") or "").strip() or None,
            "schedule": fmt_schedule(item) or None,
            "credits": credit_of.get(cno),
            # 原始字段也带上，前端如需周次/分时刻可读
            "dayOfWeek": item.get("dayOfWeek"),
            "startPeriod": item.get("startPeriod"),
            "endPeriod": item.get("endPeriod"),
        })

    record_json = {
        "studentId": sid,
        "className": class_name or None,
        "termLabel": latest_term or None,
        # 最新 studentjson 是本次模拟选课的规划目标；readingPlanTerm 是其前一在读学期。
        "planningSemester": planning_semester or None,
        # true = 该生出现在快照 failures，语义为本学期确认无课表；不是待重试错误。
        "noSchedule": no_schedule,
        # 在读培养方案第几学期（前端据此区分往期/本学期/自动填在读学期）。
        "readingPlanTerm": reading_plan_term or None,
        # 培养方案 ti<=在读 的必修 cid 全集 —— 前端用「全集 − 已修」自动算「核对必修」排除项。
        "requiredCidsUpToReading": required_up_to_reading,
        "scheduleItems": schedule_out,
        "detailCourses": detail_out,
    }

    return {
        "row": {
            "student_id": sid,
            "class_name": class_name,
            "plan_key": plan_key,
            "total_earned": round(total_earned, 2),
            "taken_count": len(detail_out),  # detail_out 已按 courseNo 去重 → 门数与课程号强绑定
            "record_json": json.dumps(record_json, ensure_ascii=False),
        },
        "record": record_json,
        "plan_key": plan_key,
        "missing_credits": missing_credits,
    }
