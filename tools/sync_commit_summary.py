#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成自动同步 commit 的语义化提交信息（deploy/sync-schedule.sh 调用）。

对比 HEAD 与工作区的 public/formal_sections.json / public/courses.json，
把「容量变化 / 新增·移除教学班 / 其他字段变化 / 预选课程增减」写成
首行摘要 + 正文明细，stdout 输出（git commit -F - 可直接用）。

产物无任何语义变化时输出退化为「master 派生数据变更」——正常情况下
sync-schedule.sh 的判变闸会在那之前就跳过提交，不会走到这里。
"""
import json
import subprocess
import sys
import time

# cron 常见 C locale 下 stdout 默认 ASCII，打印中文会 UnicodeEncodeError → 强制 UTF-8。
sys.stdout.reconfigure(encoding="utf-8")

SECTIONS = "public/formal_sections.json"
COURSES = "public/courses.json"
MAX_DETAIL = 20  # 每类明细最多列多少条，超出折叠成「等 N 条」


def load_head(path):
    p = subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True)
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def load_worktree(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def skey(s):
    return (s.get("semester", ""), s.get("id", ""), s.get("className", ""),
            (s.get("teacher") or "").strip())


def fmt_sec(s):
    return f"《{s.get('name','')}》{s.get('className','')} {s.get('teacher','') or '教师未定'}"


def clip(lines):
    if len(lines) > MAX_DETAIL:
        return lines[:MAX_DETAIL] + [f"  … 等 {len(lines)} 条"]
    return lines


def main():
    old_sec = load_head(SECTIONS)
    new_sec = load_worktree(SECTIONS)
    old_crs = load_head(COURSES)
    new_crs = load_worktree(COURSES)
    if new_sec is None:
        sys.exit("worktree public/formal_sections.json 不可读")

    parts, body = [], []

    if old_sec is not None:
        om = {skey(s): s for s in old_sec}
        nm = {skey(s): s for s in new_sec}
        added = [nm[k] for k in nm if k not in om]
        removed = [om[k] for k in om if k not in nm]
        cap_chg, other_chg = [], []
        for k, n in nm.items():
            o = om.get(k)
            if o is None:
                continue
            if o.get("capacity") != n.get("capacity"):
                cap_chg.append((o, n))
            elif o != n:
                other_chg.append(n)

        if cap_chg:
            parts.append(f"容量Δ{len(cap_chg)}")
            body.append(f"容量变化 {len(cap_chg)} 班:")
            body += clip([
                f"  {fmt_sec(n)}: {o.get('capacity')}→{n.get('capacity')}"
                for o, n in cap_chg
            ])
        if added:
            parts.append(f"+{len(added)}班")
            body.append(f"新增教学班 {len(added)}:")
            body += clip([f"  + {fmt_sec(s)}" for s in added])
        if removed:
            parts.append(f"-{len(removed)}班")
            body.append(f"移除教学班 {len(removed)}:")
            body += clip([f"  - {fmt_sec(s)}" for s in removed])
        if other_chg:
            parts.append(f"字段变更{len(other_chg)}")
            body.append(f"其他字段变化 {len(other_chg)} 班（教室/时间/标签等）:")
            body += clip([f"  ~ {fmt_sec(s)}" for s in other_chg])

    if old_crs is not None and new_crs is not None:
        oc = {c.get("id") for c in old_crs}
        nc = {c.get("id") for c in new_crs}
        crs_add, crs_del = sorted(nc - oc), sorted(oc - nc)
        if crs_add or crs_del:
            parts.append(f"课程+{len(crs_add)}/-{len(crs_del)}")
            by_id = {c.get("id"): c for c in new_crs}
            body.append(f"预选课程变化 +{len(crs_add)}/-{len(crs_del)}:")
            body += clip(
                [f"  + {cid} 《{by_id.get(cid, {}).get('name', '')}》" for cid in crs_add]
                + [f"  - {cid}" for cid in crs_del]
            )

    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    what = " ".join(parts) if parts else "master 派生数据变更"
    print(f"data: 同步 {what} (kkap {stamp}; sections={len(new_sec)})")
    if body:
        print()
        print("\n".join(body))


if __name__ == "__main__":
    main()
