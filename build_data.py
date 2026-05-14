import json
import re
import os
from collections import defaultdict, Counter

COURSE_FILE = "JXNU课程数据_2026-05-13.json"
SCHEDULE_FILE = "JXNU开课安排_2026-05-13.json"
TRAIN_PLAN_FILE = "jxnu_jxjh_v5_35847.json"
OUTPUT_DIR = "public"
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "courses.json")

# 匹配 "2x级xxx班" 模式，如 "23级电子商务（跨境电商方向）班"
MAJOR_CLASS_RE = re.compile(r"^2\d级.+班$")

# 培养方案课程性质归一化（统一为原 JSON 已有的命名）
NATURE_NORMALIZE = {
    "公共必修": "公共必修课",
}


def build_search(course: dict) -> str:
    # 搜索范围：课程号、课程名、开课学院、教师姓名+教号、tag
    # 不含培养方案归属的年级/专业/方向/课程性质 —— 避免「计算机」之类关键词
    # 命中"计算机系开设的所有课"这种无关结果（培养方案数据极广，专业名很容易撞车）
    parts = [
        course.get("id", ""),
        course.get("name", ""),
        course.get("dept", ""),
    ]
    for t in course.get("teachers", []):
        parts.append(t.get("name", ""))
        parts.append(t.get("id", ""))
    for tag in course.get("tags", []):
        parts.append(tag)
    return " ".join(parts).lower()


def main():
    with open(COURSE_FILE, encoding="utf-8") as f:
        raw_courses = json.load(f)
    with open(SCHEDULE_FILE, encoding="utf-8") as f:
        raw_schedules = json.load(f)
    with open(TRAIN_PLAN_FILE, encoding="utf-8") as f:
        raw_plans = json.load(f)

    print(f"Loaded {len(raw_courses)} courses, {len(raw_schedules)} schedule entries, {len(raw_plans)} plan entries")

    # 按课程号聚合培养方案
    plans_by_id = defaultdict(list)
    natures_by_id = defaultdict(set)
    degree_ids = set()
    for p in raw_plans:
        cid = (p.get("课程号") or "").strip()
        if not cid:
            continue
        nature = (p.get("课程性质") or "").strip()
        nature = NATURE_NORMALIZE.get(nature, nature)
        is_degree = bool((p.get("学位课程") or "").strip())
        plans_by_id[cid].append({
            "year": (p.get("年级") or "").strip(),
            "major": (p.get("专业") or "").strip(),
            "direction": (p.get("方向") or "").strip(),
            "nature": nature,
            "isDegree": is_degree,
            "semester": (p.get("开课时间") or "").strip(),
        })
        if nature:
            natures_by_id[cid].add(nature)
        if is_degree:
            degree_ids.add(cid)

    # 用开课安排判定专业课：课程号必须在两个JSON都出现，且班级名称匹配 "2x级xxx班"
    schedule_ids = set(s["课程号"] for s in raw_schedules)
    major_course_ids = set()
    for s in raw_schedules:
        if MAJOR_CLASS_RE.match(s.get("班级名称", "")):
            major_course_ids.add(s["课程号"])

    course_ids = set(c["课程号"] for c in raw_courses)
    # 专业课 = 两个JSON都有 且 开课安排中有"2x级xxx班"的班级
    major_course_ids = major_course_ids & course_ids

    print(f"  Schedule unique course IDs: {len(schedule_ids)}")
    print(f"  Overlap with course data: {len(schedule_ids & course_ids)}")
    print(f"  Major courses (by class name pattern): {len(major_course_ids)}")

    courses = []
    for c in raw_courses:
        cid = c["课程号"]

        tags = [t for t in c.get("标签", []) if t != "关键字搜索"]

        # 标签判定
        if cid.startswith("00"):
            if "公选课" not in tags:
                tags.insert(0, "公选课")
        elif re.match(r"^0[2-7]", cid):
            if "公共必修课" not in tags:
                tags.insert(0, "公共必修课")
        elif cid in major_course_ids:
            if "专业课" not in tags:
                tags.insert(0, "专业课")

        # 培养方案课程性质 tags（去重 append）
        for n in sorted(natures_by_id.get(cid, set())):
            if n not in tags:
                tags.append(n)
        is_degree = cid in degree_ids
        if is_degree and "学位课" not in tags:
            tags.append("学位课")

        try:
            credits = int(c.get("学分", "0"))
        except ValueError:
            credits = 0

        course = {
            "id": cid,
            "name": c.get("课程名称", ""),
            "credits": credits,
            "dept": c.get("课程管理单位", ""),
            "semester": c.get("开课学期", ""),
            "prereqId": c.get("先修课程号", ""),
            "prereqDesc": c.get("先修课程说明", ""),
            "desc": c.get("简介", ""),
            "tags": tags,
            "teachers": [
                {
                    "dept": t.get("单位", ""),
                    "id": t.get("教号", ""),
                    "name": t.get("姓名", ""),
                    "gender": t.get("性别", ""),
                }
                for t in c.get("教师", [])
            ],
            "isDegreeCourse": is_degree,
            "plans": plans_by_id.get(cid, []),
        }
        course["_search"] = build_search(course)
        courses.append(course)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(courses, f, ensure_ascii=False, separators=(",", ":"))

    # Stats
    type_counts = Counter()
    for c in courses:
        for t in c["tags"]:
            type_counts[t] += 1
    credit_counts = Counter(c["credits"] for c in courses)
    tagged = sum(1 for c in courses if c["tags"])
    untagged = sum(1 for c in courses if not c["tags"])

    plan_courses = sum(1 for c in courses if c["plans"])
    degree_courses = sum(1 for c in courses if c["isDegreeCourse"])

    print(f"\nOutput: {len(courses)} courses -> {OUTPUT_FILE}")
    print(f"  Tagged: {tagged}, Untagged: {untagged}")
    print(f"  Has plan info: {plan_courses}, Degree courses: {degree_courses}")
    print(f"\nTag distribution:")
    for tag, count in type_counts.most_common():
        print(f"  {tag}: {count}")
    print(f"\nCredit distribution:")
    for cr, count in sorted(credit_counts.items()):
        print(f"  {cr}学分: {count}")


if __name__ == "__main__":
    main()
