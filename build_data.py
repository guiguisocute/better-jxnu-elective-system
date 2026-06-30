"""
数据 build 流水线（见 data/ARCHITECTURE.md）。

raw 三类输入：
  data/master_raw/training_plan.json            ← 跨学期培养方案
  data/semesters/<sem>/raw/preselect_catalog.json  ← 该学期预选目录
  data/semesters/<sem>/raw/formal_schedule.json    ← 该学期正选开课安排
  data/semesters/<sem>/raw/addDrop_schedule.json   ← 该学期补退选开课安排（可缺）
  data/semesters/<sem>/meta.json                   ← isCurrent / 抓取日期等

输出两层：
  data/master/*.json   ← 跨学期持久化派生数据（courses / teachers / major_requirements）
  public/*.json        ← 前端 fetch 产物（courses / formal_sections / major_requirements）

字段优先级 merge 规则见 ARCHITECTURE.md §4。每次执行是覆盖式重算，零状态。
"""

import json
import re
import os
import sys
from collections import defaultdict, Counter

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ============ 路径常量 ============
SEMESTERS_DIR = os.path.join("data", "semesters")
MASTER_RAW_DIR = os.path.join("data", "master_raw")
MASTER_DIR = os.path.join("data", "master")
PUBLIC_DIR = "public"

TRAINING_PLAN_FILE = os.path.join(MASTER_RAW_DIR, "training_plan.json")

MASTER_COURSES_FILE = os.path.join(MASTER_DIR, "courses.json")
MASTER_TEACHERS_FILE = os.path.join(MASTER_DIR, "teachers.json")
MASTER_REQS_FILE = os.path.join(MASTER_DIR, "major_requirements.json")
MASTER_PLAN_COURSES_FILE = os.path.join(MASTER_DIR, "plan_courses.json")

PUBLIC_COURSES_FILE = os.path.join(PUBLIC_DIR, "courses.json")
PUBLIC_FORMAL_FILE = os.path.join(PUBLIC_DIR, "formal_sections.json")
PUBLIC_REQS_FILE = os.path.join(PUBLIC_DIR, "major_requirements.json")
PUBLIC_PLAN_COURSES_FILE = os.path.join(PUBLIC_DIR, "plan_courses.json")

# 课程性质归一化（公共必修 → 公共必修课，与 catalog 一致）
NATURE_NORMALIZE = {"公共必修": "公共必修课"}

# 学期级 raw 文件名（stage-based 稳定命名）
RAW_STAGES = (
    "preselect_catalog",
    "formal_schedule",
    "formal_actual",
    "addDrop_schedule",
    "addDrop_actual",
    # 选课开班状态（爬虫 tools/crawl_courses.py 产出）：真实开班信息，
    # 含 课程号/老师/容量/班级名称，但无星期/节次/教室。仅在该学期还没有
    # formal_schedule / addDrop_schedule 时作为 formal sections 的兜底来源。
    "openclass_status",
)

# 测试用学期镜像：把某学期的 formal sections 原样复制成另一个学期标签（多课表功能测试，
# 避免重复 raw）。真实多学期数据到位后清空。2025-09 与 2026-09 均已有真实课表，
# 不再需要镜像 → 置空。
MIRROR_SEMESTERS: dict[str, list[str]] = {}


# ============ 工具 ============

def format_semester(raw: str) -> str:
    """学校 学期 字段 "YYYY/M/D 0:00:00" → "YYYY-MM"（秋季学期统一记 "YYYY-09"，春季 "YYYY-03"，按实际开学月份）。"""
    if not raw:
        return ""
    try:
        date_part = raw.split(" ")[0]
        y, m, _ = date_part.split("/")
        mm = "03" if 2 <= int(m) <= 7 else "09"
        return f"{y}-{mm}"
    except (ValueError, IndexError):
        return raw


def format_schedule(day: str, period: str) -> str:
    day = (day or "").strip()
    period = (period or "").strip()
    if day and period:
        return f"{day}-{period}"
    return day or period


_WEEK_ORDER = {"星期一": 0, "星期二": 1, "星期三": 2, "星期四": 3, "星期五": 4, "星期六": 5, "星期日": 6, "星期天": 6}
_CN_FIRST_PERIOD = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}


def slot_order(entry: dict) -> tuple:
    """同一个班多个上课时段的排序键：(周几 0-6, 起始节次)。无法解析的排末尾。"""
    day = _WEEK_ORDER.get((entry.get("星期") or "").strip(), 99)
    m = re.search(r"第([一二三四五六七八九十]+|\d+)", (entry.get("节次") or "").strip())
    period = 99
    if m:
        tok = m.group(1)
        if tok in _CN_FIRST_PERIOD:
            period = _CN_FIRST_PERIOD[tok]
        elif tok.isdigit():
            # 连写块取首节："67"→6 / "12"→1；"10/11/12" 当整数
            period = int(tok) if tok in ("10", "11", "12") else int(tok[0])
    return (day, period)


def is_foreign_teacher_name(name: str) -> bool:
    """外教在预选目录中通常使用拉丁字母姓名，对应 jwc 开头的临时教号。"""
    return bool(re.search(r"[A-Za-z]", name or ""))


def is_valid_email(value: str) -> bool:
    """只接收结构完整的单一邮箱；混入手机号、缺 @ 等上游脏值不写入 master。"""
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", (value or "").strip()))


_EMPTY_PROFILE_VALUES = {"未定", "待定", "未知", "无", "暂无", "-"}


# 手动维护：开课表里出现但 catalog 没收录的外教 → jwc 教号。
# 触发场景：教师只挂正选/补退选不在预选目录，schedule 又没自带 任课老师.UserNum；
# 这种情况无法自动推导，只能写死。新增时把名字加进来即可。
FOREIGN_TEACHER_ID_OVERRIDES: dict = {
    "Delphine": "jwc7019",
    "Susannah": "jwc6989",
    "Tijana": "jwc7017",
    "Irfan": "jwc6806",
    "Serdar": "jwc7016",
}


# ============ Stage 1: 加载 raw ============

def load_semesters() -> dict:
    """读取 data/semesters/*。返回 dict[sem_label] = {meta, preselect_catalog, formal_schedule, ...}。"""
    out: dict = {}
    if not os.path.isdir(SEMESTERS_DIR):
        return out
    for entry in sorted(os.listdir(SEMESTERS_DIR)):
        sem_dir = os.path.join(SEMESTERS_DIR, entry)
        if not os.path.isdir(sem_dir):
            continue
        sem_data: dict = {"meta": {}}
        meta_file = os.path.join(sem_dir, "meta.json")
        if os.path.exists(meta_file):
            with open(meta_file, encoding="utf-8") as f:
                sem_data["meta"] = json.load(f)
        raw_dir = os.path.join(sem_dir, "raw")
        for stage in RAW_STAGES:
            fp = os.path.join(raw_dir, f"{stage}.json")
            if os.path.exists(fp):
                with open(fp, encoding="utf-8") as f:
                    sem_data[stage] = json.load(f)
        out[entry] = sem_data
    return out


def load_training_plan() -> list:
    if not os.path.exists(TRAINING_PLAN_FILE):
        return []
    with open(TRAINING_PLAN_FILE, encoding="utf-8") as f:
        return json.load(f)


def find_current_semester(semesters: dict) -> str:
    """meta.isCurrent=true 优先；否则取最新（按 label 字典序末尾）。"""
    for sem, data in semesters.items():
        if data.get("meta", {}).get("isCurrent"):
            return sem
    return sorted(semesters.keys())[-1] if semesters else ""


# ============ Stage 2: 培养方案派生 ============

def parse_training_plan(raw_plans: list):
    """v7 嵌套结构 → 各 cid 的聚合表。"""
    plans_by_id: dict = defaultdict(list)
    natures_by_id: dict = defaultdict(set)
    degree_ids: set = set()
    credits_votes: dict = defaultdict(Counter)
    names_by_id: dict = {}

    for plan in raw_plans:
        year = (plan.get("年级") or "").strip()
        major = (plan.get("专业") or "").strip()
        for c in plan.get("课程", []) or []:
            cid = (c.get("课程号") or "").strip()
            if not cid:
                continue
            nature = (c.get("课程性质") or "").strip()
            nature = NATURE_NORMALIZE.get(nature, nature)
            is_degree = bool((c.get("学位课程") or "").strip())
            plans_by_id[cid].append({
                "year": year,
                "major": major,
                "direction": (c.get("方向") or "").strip(),
                "nature": nature,
                "isDegree": is_degree,
                "semester": (c.get("开课时间") or "").strip(),
            })
            if nature:
                natures_by_id[cid].add(nature)
            if is_degree:
                degree_ids.add(cid)
            try:
                xf = int(float((c.get("学分") or "").strip()))
                if xf > 0:
                    credits_votes[cid][xf] += 1
            except (ValueError, TypeError):
                pass
            if cid not in names_by_id:
                nm = (c.get("课程名称标识") or "").strip()
                if nm:
                    names_by_id[cid] = nm

    credits_by_id = {cid: v.most_common(1)[0][0] for cid, v in credits_votes.items()}
    return plans_by_id, natures_by_id, degree_ids, credits_by_id, names_by_id


def build_major_requirements(raw_plans: list) -> list:
    by_key: dict = {}
    for p in raw_plans:
        year = (p.get("年级") or "").strip()
        major = (p.get("专业") or "").strip()
        if not year or not major:
            continue
        key = (year, major)
        if key in by_key:
            for d in p.get("方向列表") or []:
                if d and d not in by_key[key]["directions"]:
                    by_key[key]["directions"].append(d)
            continue
        by_key[key] = {
            "year": year,
            "major": major,
            "directions": list(p.get("方向列表") or []),
            "minTotal": p.get("毕业最低学分") or 0,
            "minMajorElective": p.get("专业限选最低学分") or 0,
            "byNature": p.get("按性质汇总") or {},
        }
    return list(by_key.values())


def _parse_credits(raw: str):
    """学分字符串 → number：整数返回 int，含小数返回 float（保留 0.5 学分精度）。"""
    try:
        v = float((raw or "").strip())
    except (ValueError, TypeError):
        return 0
    return int(v) if v.is_integer() else v


def build_plan_courses(raw_plans: list) -> dict:
    """每个 planKey ("YYYY级-专业") → 课程清单（按 cid 去重，方向无关，多方向合并到 directions）。
    供前端模拟选课：按学期列必修/限选课、自动核算已修。planKey 与 planMatch.planKey 同口径。"""
    by_key: dict = {}
    for p in raw_plans:
        year = (p.get("年级") or "").strip()
        major = (p.get("专业") or "").strip()
        if not year or not major:
            continue
        key = f"{year}级-{major}"
        bucket = by_key.setdefault(key, {})  # cid -> PlanCourse
        for c in p.get("课程", []) or []:
            cid = (c.get("课程号") or "").strip()
            if not cid:
                continue
            direction = (c.get("方向") or "").strip()
            if cid in bucket:
                if direction and direction not in bucket[cid]["directions"]:
                    bucket[cid]["directions"].append(direction)
                continue
            nature = (c.get("课程性质") or "").strip()
            bucket[cid] = {
                "cid": cid,
                "name": (c.get("课程名称标识") or "").strip(),
                "nature": NATURE_NORMALIZE.get(nature, nature),
                "credits": _parse_credits(c.get("学分")),
                "semester": (c.get("开课时间") or "").strip(),
                "isDegree": bool((c.get("学位课程") or "").strip()),
                "directions": [direction] if direction else [],
            }
    return {k: list(v.values()) for k, v in by_key.items()}


# ============ Stage 3: master ============

def build_master(semesters: dict, training_plan: list) -> dict:
    """合并培养方案 + 所有学期 catalog/schedule → master/{courses,teachers,major_requirements}.json。

    courses: cid 全集；name/credits 按 training_plan > catalog > schedule 优先；
             课程性质/学位课 仅 training_plan；师课绑定不进 master。
    teachers: 从各学期 catalog 累积 (教号 → 档案)。
    """
    plans_by_id, natures_by_id, degree_ids, credits_by_id, names_by_id = parse_training_plan(training_plan)

    # 收集每学期的 catalog（cid → row）与 schedule meta（cid → {name, dept}）
    catalog_per_sem: dict = {}
    sch_meta_per_sem: dict = {}
    for sem, data in semesters.items():
        cat_map: dict = {}
        for c in data.get("preselect_catalog", []) or []:
            cid = (c.get("课程号") or "").strip()
            if cid and cid not in cat_map:
                cat_map[cid] = c
        catalog_per_sem[sem] = cat_map

        sch_map: dict = {}
        for rows in (data.get("formal_schedule") or [], data.get("addDrop_schedule") or []):
            for s in rows:
                cid = (s.get("课程号") or "").strip()
                if not cid:
                    continue
                # 新格式 课程信息 自带学分 / 英文名 / 简介。按 cid 合并非空值，避免该课
                # 第一条时段行恰好缺少嵌套块时锁死为空。
                ci = s.get("课程信息") if isinstance(s.get("课程信息"), dict) else {}
                meta = sch_map.setdefault(cid, {
                    "name": "", "dept": "", "credits": 0, "englishName": "", "desc": "",
                })
                if not meta["name"]:
                    meta["name"] = (
                        (s.get("课程名称") or "").strip()
                        or (ci.get("课程名称标识") or ci.get("课程名称") or "").strip()
                    )
                if not meta["dept"]:
                    meta["dept"] = (s.get("单位名称") or "").strip()
                if not meta["credits"]:
                    meta["credits"] = _parse_credits(ci.get("学分"))
                if not meta["englishName"]:
                    meta["englishName"] = (ci.get("课程英文名称") or "").strip()
                if not meta["desc"]:
                    meta["desc"] = (ci.get("内容简介") or "").strip()
        # openclass_status：让只出现在开班数据里的真实课程号（不在预选目录/课表里）也进 master。
        oc = data.get("openclass_status")
        if oc:
            for r in iter_openclass_rows(oc):
                cid = r["cid"]
                if not cid:
                    continue
                meta = sch_map.setdefault(cid, {
                    "name": "", "dept": "", "credits": 0, "englishName": "", "desc": "",
                })
                if not meta["name"]:
                    meta["name"] = r["name"]
                if not meta["dept"]:
                    meta["dept"] = r["dept"]
        sch_meta_per_sem[sem] = sch_map

    # cid 全集
    cids: set = set(plans_by_id.keys())
    for m in catalog_per_sem.values():
        cids.update(m.keys())
    for m in sch_meta_per_sem.values():
        cids.update(m.keys())

    # 学期倒序找最近一次的 catalog / schedule 元数据
    sems_desc = sorted(semesters.keys(), reverse=True)

    courses = []
    for cid in sorted(cids):
        cat_row = next((catalog_per_sem[s][cid] for s in sems_desc if cid in catalog_per_sem[s]), None)
        sch_rows = [sch_meta_per_sem[s][cid] for s in sems_desc if cid in sch_meta_per_sem[s]]

        def latest_schedule_value(field: str, default=""):
            return next((row[field] for row in sch_rows if row.get(field)), default)

        # 名称：training_plan > catalog > schedule
        name = (
            names_by_id.get(cid)
            or (cat_row.get("课程名称", "") if cat_row else "")
            or latest_schedule_value("name")
        )

        # 学分：training_plan > catalog > schedule（schedule 兜底覆盖只在课表出现的纯慕课课等）
        credits = credits_by_id.get(cid, 0)
        if credits == 0 and cat_row:
            try:
                credits = int(cat_row.get("学分", "0") or 0)
            except ValueError:
                credits = 0
        if credits == 0:
            credits = latest_schedule_value("credits", 0)

        # 学院：catalog > schedule（training_plan 无此字段）
        dept = ""
        if cat_row:
            dept = (cat_row.get("课程管理单位", "") or "").strip()
        if not dept:
            dept = latest_schedule_value("dept")

        # 标签：catalog 原 tags（去关键字搜索）+ 前缀派生 + nature + 学位课
        tags: list = []
        if cat_row:
            tags = [t for t in (cat_row.get("标签", []) or []) if t != "关键字搜索"]
        if cid.startswith("00") and "公选课" not in tags:
            tags.insert(0, "公选课")
        elif re.match(r"^0[2-7]", cid) and "公共必修课" not in tags:
            tags.insert(0, "公共必修课")
        for n in sorted(natures_by_id.get(cid, set())):
            if n not in tags:
                tags.append(n)
        is_degree = cid in degree_ids
        if is_degree and "学位课" not in tags:
            tags.append("学位课")

        english_name = latest_schedule_value("englishName")
        # catalog 简介通常更完整；没有时再用最新正式课表的 课程信息.内容简介 补齐。
        desc = (cat_row.get("简介", "") if cat_row else "") or latest_schedule_value("desc")
        prereqId = (cat_row.get("先修课程号", "") if cat_row else "") or ""
        prereqDesc = (cat_row.get("先修课程说明", "") if cat_row else "") or ""

        courses.append({
            "id": cid,
            "name": name,
            "englishName": english_name,
            "credits": credits,
            "dept": dept,
            "prereqId": prereqId,
            "prereqDesc": prereqDesc,
            "desc": desc,
            "tags": tags,
            "isDegreeCourse": is_degree,
            "plans": plans_by_id.get(cid, []),
        })

    # Teachers：从各学期 catalog + schedule 任课老师 累积。学期标签用 meta.label，与 sections 一致。
    # schedule 自带 任课老师 是新格式特性；让 master 也能记录「只在开课表出现」的老师。
    teachers_acc: dict = {}

    def _upsert_teacher(
        tid: str,
        name: str,
        gender: str,
        dept: str,
        sem_label: str,
        *,
        email: str = "",
        title: str = "",
        bio: str = "",
    ):
        tid = (tid or "").strip()
        if not tid:
            return
        if tid not in teachers_acc:
            teachers_acc[tid] = {
                "id": tid,
                "name": (name or "").strip(),
                "gender": (gender or "").strip(),
                "email": "",
                "title": "",
                "bio": "",
                "depts": [],
                "firstSeenSem": sem_label,
                "lastSeenSem": sem_label,
            }
        tr = teachers_acc[tid]
        tr["lastSeenSem"] = sem_label
        if not tr["name"] and name:
            tr["name"] = name.strip()
        if not tr["gender"] and gender:
            tr["gender"] = gender.strip()
        clean_email = (email or "").strip()
        if is_valid_email(clean_email):
            tr["email"] = clean_email
        clean_title = (title or "").strip()
        if clean_title and clean_title not in _EMPTY_PROFILE_VALUES:
            tr["title"] = clean_title
        clean_bio = (bio or "").strip()
        if clean_bio:
            tr["bio"] = clean_bio
        d = (dept or "").strip()
        if d and d not in tr["depts"]:
            tr["depts"].append(d)

    for sem in sorted(semesters.keys()):
        sem_label = semesters[sem].get("meta", {}).get("label") or sem
        for c in semesters[sem].get("preselect_catalog", []) or []:
            for t in c.get("教师", []) or []:
                _upsert_teacher(t.get("教号"), t.get("姓名"), t.get("性别"), t.get("单位"), sem_label)
        # schedule 内 任课老师 块（新格式）：拿 UserNum / 姓名 / 性别；schedule 没有 单位 字段
        for stage in ("formal_schedule", "addDrop_schedule"):
            for r in semesters[sem].get(stage) or []:
                embed = r.get("任课老师")
                if not isinstance(embed, dict):
                    continue
                _upsert_teacher(
                    embed.get("UserNum"),
                    embed.get("姓名") or r.get("任课教师"),
                    embed.get("性别"),
                    r.get("单位名称"),
                    sem_label,
                    email=embed.get("Email"),
                    title=embed.get("职称"),
                    bio=embed.get("教学简介"),
                )
        # openclass_status 必修「选课结果」自带 教号+姓名 —— 累积进 master（跳过占位 000000/待定）。
        oc = semesters[sem].get("openclass_status")
        if oc:
            for g in oc.get("colleges", []) or []:
                college = (g.get("college") or "").strip()
                for c in g.get("courses", []) or []:
                    for r in c.get("选课结果", []) or []:
                        tid = (r.get("教号") or "").strip()
                        if not tid or tid == "000000":
                            continue
                        _upsert_teacher(tid, r.get("教师姓名"), "", college, sem_label)
    teachers = sorted(teachers_acc.values(), key=lambda t: t["id"])

    reqs = build_major_requirements(training_plan)
    plan_courses = build_plan_courses(training_plan)

    os.makedirs(MASTER_DIR, exist_ok=True)
    with open(MASTER_COURSES_FILE, "w", encoding="utf-8") as f:
        json.dump(courses, f, ensure_ascii=False, separators=(",", ":"))
    with open(MASTER_TEACHERS_FILE, "w", encoding="utf-8") as f:
        json.dump(teachers, f, ensure_ascii=False, separators=(",", ":"))
    with open(MASTER_REQS_FILE, "w", encoding="utf-8") as f:
        json.dump(reqs, f, ensure_ascii=False, separators=(",", ":"))
    with open(MASTER_PLAN_COURSES_FILE, "w", encoding="utf-8") as f:
        json.dump(plan_courses, f, ensure_ascii=False, separators=(",", ":"))

    return {"courses": courses, "teachers": teachers, "reqs": reqs, "planCourses": plan_courses}


# ============ Stage 4: public ============

def _parse_int(v) -> int | None:
    """容量/人数 文本 → int；空/非数字 → None。"""
    try:
        s = str(v).strip()
        return int(float(s)) if s else None
    except (ValueError, TypeError):
        return None


def iter_openclass_rows(openclass: dict):
    """展平 openclass_status（嵌套 colleges→courses→班级/开班/选课结果）为 section 级 dict 流。

    每条 yield：{cid, name, dept, teacher, teacherId, className, capacity, nature}
      - 必修：每条「班级」行一个 section；teacherId 先按姓名匹配该课「选课结果」的教号。
      - 选修：每条「开班」行一个 section；teacherId 留空（由 catalog t_lookup 兜底）。
    无星期/节次/教室 —— schedule/classroom 留空，待后续带时段数据补。
    """
    for g in openclass.get("colleges", []) or []:
        college = (g.get("college") or "").strip()
        for c in g.get("courses", []) or []:
            cid = (c.get("course_num") or "").strip()
            if not cid:
                continue
            info = c.get("info") or {}
            name = (info.get("课程名称标识") or "").strip()
            nature = c.get("nature") or ""
            if nature == "必修":
                tid_by_name: dict = {}
                for r in c.get("选课结果", []) or []:
                    nm = (r.get("教师姓名") or "").strip()
                    tid = (r.get("教号") or "").strip()
                    if nm and tid and nm not in tid_by_name:
                        tid_by_name[nm] = tid
                for r in c.get("班级", []) or []:
                    teacher = (r.get("任课老师") or "").strip()
                    yield {
                        "cid": cid, "name": name, "dept": college,
                        "teacher": teacher, "teacherId": tid_by_name.get(teacher, ""),
                        "className": (r.get("班级名称") or "").strip(),
                        "capacity": _parse_int(r.get("班级人数")),
                        "nature": nature,
                    }
            else:  # 选修
                # 教学院长审核状态（lblInfor 的 <li> 文案：「教学院长已经审核！」/「教学院长未审核！」）
                approved = any(
                    "已经审核" in n or ("审核" in n and "未审核" not in n)
                    for n in (c.get("info_notes") or [])
                )
                for r in c.get("开班", []) or []:
                    cap_raw = (r.get("每班容量") or "").strip()
                    kb = (r.get("拟开班数") or "").strip()
                    # 已审核 且 拟开班数=0 且 每班容量=0 = 教学院长已确认本班不开 → 排除
                    if approved and kb == "0" and cap_raw == "0":
                        continue
                    teacher = (r.get("任课老师姓名") or "").strip()
                    yield {
                        "cid": cid, "name": name,
                        "dept": (r.get("任课老师所在单位") or college).strip(),
                        "teacher": teacher, "teacherId": "",
                        "className": "",
                        "capacity": _parse_int(cap_raw),
                        "nature": nature,
                    }


def build_openclass_capacity_lookup(openclass: dict) -> dict[tuple[str, str], int]:
    """按 (课程号, 班级名称) 提取可安全复用的 openclass 容量。

    只保留班级名非空、容量非空且同键仅有一个容量值的记录；若上游以后出现
    同一键多个容量，保守跳过，避免把容量写到错误教学班。
    """
    values: dict[tuple[str, str], set[int]] = defaultdict(set)
    for row in iter_openclass_rows(openclass):
        key = ((row.get("cid") or "").strip(), (row.get("className") or "").strip())
        capacity = row.get("capacity")
        if key[0] and key[1] and capacity is not None:
            values[key].add(capacity)
    return {key: next(iter(capacities)) for key, capacities in values.items() if len(capacities) == 1}


def build_sections_from_openclass(
    openclass: dict, master_by_id: dict, teacher_id_lookup: dict, sem_label: str,
) -> list:
    """openclass_status → FormalSection 行（结构同 build_sections_for_semester，但 schedule/classroom 空）。"""
    sections = []
    for row in iter_openclass_rows(openclass):
        cid = row["cid"]
        mc = master_by_id.get(cid, {})
        name = row["name"] or mc.get("name", "")
        dept = mc.get("dept", "") or row["dept"]
        teacher = row["teacher"]
        teacher_id = (
            row["teacherId"]
            or teacher_id_lookup.get((cid, teacher), "")
            or teacher_id_lookup.get(("", teacher), "")
        )
        section = {
            "id": cid,
            "name": name,
            "credits": mc.get("credits", 0),
            "dept": dept,
            "tags": mc.get("tags", []),
            "teacher": teacher,
            "teacherId": teacher_id,
            "schedule": "",          # openclass 无星期/节次 —— 周课表网格暂空
            "className": row["className"],
            "bjh": "",               # openclass 无班级号
            "classroom": "",         # openclass 无教室号
            "capacity": row["capacity"],
            "semester": sem_label,
            "desc": "",
        }
        sp = [section["id"], section["name"], mc.get("englishName", ""), section["dept"], section["teacher"],
              section["teacherId"], section["className"], *section["tags"]]
        section["_search"] = " ".join(p for p in sp if p).lower()
        sections.append(section)
    return sections


def build_search_course(course: dict, teachers: list) -> str:
    parts = [course["id"], course["name"], course.get("englishName", ""), course["dept"]]
    for t in teachers:
        parts.append(t.get("name", ""))
        parts.append(t.get("id", ""))
    for tag in course["tags"]:
        parts.append(tag)
    return " ".join(parts).lower()


def build_sections_for_semester(
    rows: list,
    master_by_id: dict,
    teacher_id_lookup: dict,
    sem_label: str,
    unmatched_foreign_teachers: list | None = None,
    capacity_lookup: dict[tuple[str, str], int] | None = None,
) -> list:
    """开课安排 → section 行（按 (课程号, 班级号, 任课教师) 聚合时段）。

    section.semester 取 sem_label（即学期目录名），不再用 `format_semester` 解析 raw 内 学期 字段。
    目录是权威：data/semesters/<sem_label>/ 决定该学期所有 section 的 label。

    教号优先级：行内 `任课老师.UserNum`（新格式自带） > teacher_id_lookup（按 (cid, name) 查 catalog）
              > teacher_id_lookup（按 ("", name) 查同学期 catalog 的唯一 jwc 外教）。
    """
    grouped: dict = defaultdict(list)
    for s in rows:
        key = (s.get("课程号", ""), s.get("班级号", ""), s.get("任课教师", ""))
        grouped[key].append(s)

    sections = []
    for (cid, bjh, teacher), entries in grouped.items():
        first = entries[0]
        # 同一班的多个上课时段：按 (周几, 起始节次) 稳定排序 + 去重，保证顺序一致、不重复。
        sched = []
        for e in sorted(entries, key=slot_order):
            s = format_schedule(e.get("星期", ""), e.get("节次", ""))
            if s and s not in sched:
                sched.append(s)
        rooms = sorted({(e.get("教室") or "").strip() for e in entries if e.get("教室")})

        mc = master_by_id.get(cid, {})
        name = first.get("课程名称", "") or mc.get("name", "")
        dept = mc.get("dept", "") or first.get("单位名称", "")

        # 教号：先看本 section 任何一条 entry 自带的 任课老师.UserNum，没有再走 catalog 查找
        embedded_tid = ""
        for e in entries:
            embed = e.get("任课老师")
            if isinstance(embed, dict):
                u = (embed.get("UserNum") or "").strip()
                if u:
                    embedded_tid = u
                    break
        teacher_id = embedded_tid or teacher_id_lookup.get((cid, teacher), "") or teacher_id_lookup.get(("", teacher), "")
        if not teacher_id and unmatched_foreign_teachers is not None and is_foreign_teacher_name(teacher):
            unmatched_foreign_teachers.append({
                "semester": sem_label,
                "courseId": cid,
                "courseName": name,
                "teacher": teacher,
            })

        # 课程信息（新格式自带）覆盖 master 的学分 / 注入简介。仅影响 section，不动 master.courses。
        # 设计上「正选数据为准」——同一课程号在预选/正选有出入时，正选表与详情页用正选字段。
        ci = first.get("课程信息") if isinstance(first.get("课程信息"), dict) else {}
        sec_credits = mc.get("credits", 0)
        try:
            ci_xf = int(float((ci.get("学分") or "").strip()))
            if ci_xf > 0:
                sec_credits = ci_xf
        except (ValueError, TypeError, AttributeError):
            pass
        sec_desc = (ci.get("内容简介") or "").strip()

        class_name = (first.get("班级名称") or "").strip()
        capacity = (capacity_lookup or {}).get((cid.strip(), class_name))
        section = {
            "id": cid,
            "name": name,
            "credits": sec_credits,
            "dept": dept,
            "tags": mc.get("tags", []),
            "teacher": teacher,
            "teacherId": teacher_id,
            "schedule": " / ".join(sched),
            "className": class_name,
            "bjh": (bjh or "").strip(),  # 班级号（教学班号）—— 详情页展示「班级名(班级号)」；同 bjh = 同教学班
            "classroom": " / ".join(rooms),
            "capacity": capacity,
            "semester": sem_label,
            "desc": sec_desc,
        }
        sp = [section["id"], section["name"], mc.get("englishName", ""), section["dept"], section["teacher"],
              section["teacherId"], section["className"], section["classroom"], *section["tags"]]
        section["_search"] = " ".join(p for p in sp if p).lower()
        sections.append(section)
    return sections


def build_public(semesters: dict, master: dict) -> None:
    """生成前端 fetch 的 3 个 JSON。

    - courses.json：当前学期 preselect_catalog 命中的 master 课程 + 该学期师课绑定
    - formal_sections.json：全部学期 formal + addDrop 合并
    - major_requirements.json：master 副本
    """
    current_sem = find_current_semester(semesters)
    master_by_id = {c["id"]: c for c in master["courses"]}
    teachers_by_id = {t["id"]: t for t in master["teachers"]}
    current_label = (
        semesters.get(current_sem, {}).get("meta", {}).get("label") or current_sem
        if current_sem else None
    )

    public_courses = []
    if current_sem and "preselect_catalog" in semesters.get(current_sem, {}):
        cat = semesters[current_sem]["preselect_catalog"] or []
        for c in cat:
            cid = (c.get("课程号") or "").strip()
            if not cid or cid not in master_by_id:
                continue
            base = master_by_id[cid]
            teachers = [
                {
                    "dept": (t.get("单位") or "").strip(),
                    "id": (t.get("教号") or "").strip(),
                    "name": (t.get("姓名") or "").strip(),
                    "gender": (t.get("性别") or "").strip(),
                }
                for t in (c.get("教师") or [])
            ]
            course = {
                **base,
                "teachers": teachers,
                "semester": (c.get("开课学期") or "").strip(),
                "inPre": True,
            }
            course["_search"] = build_search_course(course, teachers)
            public_courses.append(course)

    # formal_sections：所有学期 formal + addDrop。学期标签 = 目录名（权威源）。
    public_sections = []
    unmatched_foreign_teachers: list = []
    for sem in sorted(semesters.keys()):
        data = semesters[sem]
        sem_label = data.get("meta", {}).get("label") or sem
        # (cid, teacher_name) → teacher_id：先取 catalog，再用 schedule 自带的 任课老师.UserNum 补强。
        # 后者让「催课表新增了但 catalog 缺录」的老师也能拿到教号，正选/补退选评分按钮才会出现。
        t_lookup: dict = {}
        jwc_ids_by_name: dict = defaultdict(set)
        for c in data.get("preselect_catalog", []) or []:
            cid = (c.get("课程号") or "").strip()
            for t in (c.get("教师") or []):
                tname = (t.get("姓名") or "").strip()
                tid = (t.get("教号") or "").strip()
                if cid and tname and tid and (cid, tname) not in t_lookup:
                    t_lookup[(cid, tname)] = tid
                if tname and tid.lower().startswith("jwc"):
                    jwc_ids_by_name[tname].add(tid)
        for tname, tids in jwc_ids_by_name.items():
            if len(tids) == 1:
                t_lookup[("", tname)] = next(iter(tids))
        # 手填外教兜底（catalog 无 → 不会进 jwc_ids_by_name；仅在没有其他来源时生效）
        for tname, tid in FOREIGN_TEACHER_ID_OVERRIDES.items():
            t_lookup.setdefault(("", tname), tid)
        for stage in ("formal_schedule", "addDrop_schedule"):
            for r in data.get(stage) or []:
                cid = (r.get("课程号") or "").strip()
                tname = (r.get("任课教师") or "").strip()
                embed = r.get("任课老师")
                if isinstance(embed, dict):
                    tid = (embed.get("UserNum") or "").strip()
                    if cid and tname and tid and (cid, tname) not in t_lookup:
                        t_lookup[(cid, tname)] = tid
        # 带时段的正式课表是 section 真值源；尚未发布课表时，才用 openclass_status
        # 先提供真实课程/老师/容量（但 schedule/classroom 为空）。
        has_schedule_rows = any(data.get(stage) for stage in ("formal_schedule", "addDrop_schedule"))
        if has_schedule_rows:
            capacity_lookup = build_openclass_capacity_lookup(data["openclass_status"]) if data.get("openclass_status") else {}
            for stage in ("formal_schedule", "addDrop_schedule"):
                rows = data.get(stage) or []
                if not rows:
                    continue
                public_sections.extend(build_sections_for_semester(
                    rows,
                    master_by_id,
                    t_lookup,
                    sem_label,
                    unmatched_foreign_teachers,
                    capacity_lookup,
                ))
        elif data.get("openclass_status"):
            public_sections.extend(
                build_sections_from_openclass(
                    data["openclass_status"], master_by_id, t_lookup, sem_label,
                )
            )

    # 测试用：镜像学期（同一份 formal 数据换个学期标签，验证多课表切换）。
    if MIRROR_SEMESTERS:
        mirrors = []
        for s in public_sections:
            for dst in MIRROR_SEMESTERS.get(s.get("semester"), []):
                clone = dict(s)
                clone["semester"] = dst
                mirrors.append(clone)
        public_sections.extend(mirrors)

    # 用当前学期 formal 真实老师补全 courses.json（让正选「任意选修」筛选与预选一致）：
    #   - 当前学期 formal 里 master 有、预选目录没有的课 → 补成预选视图条目（inPre=False）。
    #   - 预选有课但缺老师的 → 用 formal 真实老师补全（不动本来就有老师的课）。
    # 这样 coursesById 覆盖所有当前学期 formal cid，前端按 plans 派生的合成 tag（任意选修）才不丢。
    if current_label:
        # cid → 该课当前学期 formal 的真实老师（按出现顺序去重）。teacher 单位/性别 从 master.teachers 补。
        formal_teachers_by_cid: dict = {}
        for s in public_sections:
            if s.get("semester") != current_label:
                continue
            cid = s["id"]
            tid = (s.get("teacherId") or "").strip()
            tname = (s.get("teacher") or "").strip()
            if not tname:
                continue
            bucket = formal_teachers_by_cid.setdefault(cid, {})
            key = tid or tname
            if key in bucket:
                continue
            tr = teachers_by_id.get(tid) if tid else None
            bucket[key] = {
                "dept": (tr["depts"][0] if tr and tr.get("depts") else ""),
                "id": tid,
                "name": (tr["name"] if tr and tr.get("name") else tname),
                "gender": (tr.get("gender") if tr else "") or "",
            }

        by_id = {c["id"]: c for c in public_courses}
        for cid, bucket in formal_teachers_by_cid.items():
            if cid not in master_by_id:
                continue
            formal_teachers = list(bucket.values())
            existing = by_id.get(cid)
            if existing is None:
                course = {
                    **master_by_id[cid],
                    "teachers": formal_teachers,
                    "semester": current_label,
                    "inPre": False,
                    "teachersFromFormal": True,
                }
                course["_search"] = build_search_course(course, formal_teachers)
                public_courses.append(course)
                by_id[cid] = course
            elif not existing.get("teachers"):
                existing["teachers"] = formal_teachers
                existing["teachersFromFormal"] = True
                existing["_search"] = build_search_course(existing, formal_teachers)

    os.makedirs(PUBLIC_DIR, exist_ok=True)
    with open(PUBLIC_COURSES_FILE, "w", encoding="utf-8") as f:
        json.dump(public_courses, f, ensure_ascii=False, separators=(",", ":"))
    with open(PUBLIC_FORMAL_FILE, "w", encoding="utf-8") as f:
        json.dump(public_sections, f, ensure_ascii=False, separators=(",", ":"))
    with open(PUBLIC_REQS_FILE, "w", encoding="utf-8") as f:
        json.dump(master["reqs"], f, ensure_ascii=False, separators=(",", ":"))
    with open(PUBLIC_PLAN_COURSES_FILE, "w", encoding="utf-8") as f:
        json.dump(master["planCourses"], f, ensure_ascii=False, separators=(",", ":"))

    return current_sem, len(public_courses), len(public_sections), unmatched_foreign_teachers


# ============ 入口 ============

def main():
    semesters = load_semesters()
    training_plan = load_training_plan()
    if not semesters:
        print("WARNING: data/semesters/ 下没有任何学期目录")
    if not training_plan:
        print("WARNING: data/master_raw/training_plan.json 未找到或为空")

    print(f"Loaded {len(training_plan)} training-plan majors across years")
    for sem in sorted(semesters.keys()):
        data = semesters[sem]
        cat = len(data.get("preselect_catalog") or [])
        fs = len(data.get("formal_schedule") or [])
        ad = len(data.get("addDrop_schedule") or [])
        cur = " [current]" if data.get("meta", {}).get("isCurrent") else ""
        print(f"  semester {sem}{cur}: catalog={cat} formal={fs} addDrop={ad}")

    print("\nBuilding master/...")
    master = build_master(semesters, training_plan)
    print(f"  courses: {len(master['courses'])}")
    print(f"  teachers: {len(master['teachers'])}")
    print(f"  major_requirements: {len(master['reqs'])}")
    print(f"  plan_courses: {len(master['planCourses'])} plans")

    print("\nBuilding public/...")
    current_sem, n_courses, n_sections, unmatched_foreign_teachers = build_public(semesters, master)
    print(f"  courses.json: {n_courses} courses (current sem: {current_sem})")
    print(f"  formal_sections.json: {n_sections} sections")
    print(f"  major_requirements.json: {len(master['reqs'])} entries")
    if unmatched_foreign_teachers:
        unique = sorted({
            (x["semester"], x["courseId"], x["courseName"], x["teacher"])
            for x in unmatched_foreign_teachers
        })
        print("  unmatched foreign teachers without jwc id:")
        for sem, cid, name, teacher in unique:
            print(f"    - {sem} {cid} {name}: {teacher}")


if __name__ == "__main__":
    main()
