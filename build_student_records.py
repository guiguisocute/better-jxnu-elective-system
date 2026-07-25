"""
学生档案 build —— studentjson/ 的 8 份学期快照 → D1 student_records 表的 SQL dump。

输入：
  studentjson/*.json    （学校教务导出的全校课表快照；data=有课表，failures=该学期确认无课表）
  data/master/courses.json          （联学分用：courseNo→credits）
  data/master/plan_courses.json     （planKey 集合，校验匹配）
  data/master/major_requirements.json（planKey 集合，校验匹配）

输出：
  studentjson/out/student_records_NN.sql  分块的 INSERT OR REPLACE，配合
    npx wrangler d1 execute jxnu-students --remote --file=studentjson/out/student_records_01.sql
    ... 逐个 import。

不修改任何源数据；幂等，重跑覆盖。
"""

import json
import os
import re
import sys
import glob

# 联表核心（helpers + load_master_ctx + build_record）抽到 tools/student_record_lib.py，
# 与实时抓取服务共用同一份口径。build_student_records 只负责快照聚合 + SQL 输出。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
from student_record_lib import load_json, load_master_ctx, build_record  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ============ 路径 ============
STUDENTJSON_DIR = "studentjson"
OUT_DIR = os.path.join(STUDENTJSON_DIR, "out")

# 每个 SQL 文件最多多少条 INSERT —— wrangler d1 execute 对单文件 SQL 有体量上限，分块更稳。
CHUNK_SIZE = 2000


# ============ 工具 ============

def sql_str(s):
    """转义为 SQL 字符串字面量；内部单引号双写；None→NULL（无引号）。"""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def sql_num(v):
    if v is None:
        return "NULL"
    try:
        n = float(v)
        if n != n:  # NaN
            return "NULL"
        # int-y 输出整型，省字节
        if n.is_integer():
            return str(int(n))
        return repr(n)
    except (TypeError, ValueError):
        return "NULL"


def snapshot_sort_key(path):
    """按文件内 termValue (year, month) 排时间序 —— 不依赖文件名（中文/编号都可能乱序）。"""
    try:
        head = open(path, encoding="utf-8").read(16384)
        m = re.search(r'"termValue"\s*:\s*"(\d{4})/(\d{1,2})/', head)
        if m:
            return (int(m.group(1)), int(m.group(2)))
    except OSError:
        pass
    return (9999, 99)


def snapshot_term_label(snapshot):
    """从快照的完整记录提取统一学期标签，供无课表 failures 记录复用。"""
    labels = {
        str(row.get("termLabel") or "").strip()
        for row in (snapshot.get("data") or [])
        if str(row.get("termLabel") or "").strip()
    }
    if len(labels) != 1:
        raise ValueError(f"快照 termLabel 应唯一，实际为: {sorted(labels)}")
    return next(iter(labels))


# ============ 主流程 ============

def main():
    if not os.path.isdir(STUDENTJSON_DIR):
        sys.exit(f"找不到 {STUDENTJSON_DIR}/")

    print("载入 master + plan_courses + major_requirements …")
    ctx = load_master_ctx()
    print(f"  master 课程: {len(ctx['credit_of'])} 条；大学英语特色课(全局标记): {len(ctx['english_feature_cids'])} 门")
    print(f"  planKey 集合: {len(ctx['valid_keys'])} 个")

    # 学生聚合容器（脱敏：不保留姓名）
    # students[sid] = {
    #   "className": last seen, "latest_*": 最新快照信息,
    #   "courses": dict[courseNo] -> {courseName, teacher, teachingClass, semester(最早出现的 termLabel)}
    # }
    # 门数以 courseNo 为唯一键：同一课程号严格算一门（重修/多班级不重复计数）。
    students = {}
    # 按文件内 termValue 排时间序（不靠文件名），idx 越大 = 越新 → 用于"最新快照"判断。
    snapshot_files = sorted(glob.glob(os.path.join(STUDENTJSON_DIR, "*.json")), key=snapshot_sort_key)
    print(f"读取 {len(snapshot_files)} 份快照 …")
    missing_credit_codes = set()

    for idx, path in enumerate(snapshot_files):
        snap = load_json(path)
        rows = snap.get("data", []) or []
        print(f"  {os.path.basename(path)}: {len(rows)} 名学生")
        for s in rows:
            sid = str(s.get("studentId") or "").strip()
            if not sid:
                continue
            rec = students.setdefault(sid, {
                "className": "",
                "courses": {},
                "latest_idx": -1,
                "latest_term": "",
                "latest_schedule": [],
                "latest_no_schedule": False,
            })
            cls = str(s.get("className") or "").strip()
            # className 取最新一份（学生升级换班的话用最近的）
            if cls and idx >= rec["latest_idx"]:
                rec["className"] = cls

            term_label = str(s.get("termLabel") or "").strip()

            for dc in (s.get("detailCourses") or []):
                cno = str(dc.get("courseNo") or "").strip()
                if not cno:
                    continue
                # 同 cno 多次（重修/跨学期）只保留一份，semester 用最早记录
                cur = rec["courses"].get(cno)
                if cur is None:
                    rec["courses"][cno] = {
                        "courseName": str(dc.get("courseName") or "").strip(),
                        "teacher": str(dc.get("teacher") or "").strip(),
                        "teachingClass": str(dc.get("teachingClass") or "").strip(),
                        "semester": term_label,
                    }
                else:
                    # 课名/教师如果之前为空，补一下
                    if not cur["courseName"] and dc.get("courseName"):
                        cur["courseName"] = str(dc["courseName"]).strip()
                    if not cur["teacher"] and dc.get("teacher"):
                        cur["teacher"] = str(dc["teacher"]).strip()

            # scheduleItems: 仅保留"最新一份快照"的（用于未来 26 秋导入后直接渲染下学期）
            sched = s.get("scheduleItems") or []
            if idx >= rec["latest_idx"]:
                rec["latest_idx"] = idx
                rec["latest_term"] = term_label
                rec["latest_schedule"] = sched
                rec["latest_no_schedule"] = False

        # failures 是本快照中“确认无课表”的学生，不是应丢弃的抓取残次。
        # 仍将其最新学期推进到本快照，课表置空；历史课程/学分继续保留。
        # 从未有过完整记录的学号也建立空档案，保证每份全校快照的人员全集不丢失。
        failures = snap.get("failures", []) or []
        term_label = snapshot_term_label(snap)
        successful_ids = {
            str(row.get("studentId") or "").strip()
            for row in rows
            if str(row.get("studentId") or "").strip()
        }
        no_schedule_count = 0
        for failure in failures:
            sid = str(failure.get("studentId") or "").strip()
            if not sid or sid in successful_ids:
                continue
            rec = students.setdefault(sid, {
                "className": "",
                "courses": {},
                "latest_idx": -1,
                "latest_term": "",
                "latest_schedule": [],
                "latest_no_schedule": False,
            })
            if idx >= rec["latest_idx"]:
                rec["latest_idx"] = idx
                rec["latest_term"] = term_label
                rec["latest_schedule"] = []
                rec["latest_no_schedule"] = True
            no_schedule_count += 1
        print(f"    无课表: {no_schedule_count} 名；本快照人员合计: {len(successful_ids) + no_schedule_count} 名")

    print(f"\n合并后：去重学生 {len(students)} 名")

    # 把每个学生映射成最终 row + record_json（联表逻辑在 student_record_lib.build_record，
    # 与实时抓取服务共用同一份口径；这里只做聚合 → 调用 → 汇总统计）。
    out_rows = []
    matched_plan = 0
    missing_plan_samples = []

    for sid in sorted(students.keys()):
        rec = students[sid]
        result = build_record(
            sid,
            rec["className"],
            rec["courses"],
            rec["latest_term"],
            rec["latest_schedule"],
            rec["latest_no_schedule"],
            ctx,
        )
        missing_credit_codes |= result["missing_credits"]
        if result["plan_key"]:
            matched_plan += 1
        elif rec["className"] and len(missing_plan_samples) < 12:
            missing_plan_samples.append(rec["className"])
        out_rows.append(result["row"])

    print(f"  planKey 命中: {matched_plan}/{len(out_rows)} = {matched_plan*100//max(1,len(out_rows))}%")
    print(f"  courseNo 缺学分: {len(missing_credit_codes)} 个（按 0 学分计）")
    if missing_plan_samples:
        print(f"  未命中 className 例:")
        for s in missing_plan_samples:
            print(f"    {s}")

    # ============ 写 SQL ============
    os.makedirs(OUT_DIR, exist_ok=True)
    # 清理旧 chunk
    for old in glob.glob(os.path.join(OUT_DIR, "student_records_*.sql")):
        os.remove(old)

    cols = "(student_id, class_name, plan_key, total_earned, taken_count, record_json)"
    total_chunks = (len(out_rows) + CHUNK_SIZE - 1) // CHUNK_SIZE
    for ci in range(total_chunks):
        chunk = out_rows[ci * CHUNK_SIZE : (ci + 1) * CHUNK_SIZE]
        out_path = os.path.join(OUT_DIR, f"student_records_{ci+1:02d}.sql")
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(f"-- chunk {ci+1}/{total_chunks}, {len(chunk)} rows\n")
            for r in chunk:
                f.write(
                    f"INSERT OR REPLACE INTO student_records {cols} VALUES ("
                    f"{sql_str(r['student_id'])}, "
                    f"{sql_str(r['class_name'])}, "
                    f"{sql_str(r['plan_key'])}, "
                    f"{sql_num(r['total_earned'])}, "
                    f"{sql_num(r['taken_count'])}, "
                    f"{sql_str(r['record_json'])}"
                    f");\n"
                )
        print(f"  -> {out_path} ({len(chunk)} rows)")

    print(f"\nDone. 共 {len(out_rows)} 行，分 {total_chunks} 个 SQL 文件。")
    print("部署：对每个 chunk 执行：")
    print("  npx wrangler d1 execute jxnu-students --remote --file=studentjson/out/student_records_01.sql")
    print("  （首次记得先 d1 execute --file=d1_schema.sql 建表）")


if __name__ == "__main__":
    main()
