import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_data import (merge_2026_course_reference, load_training_plan,
                        build_major_requirements, parse_training_plan, build_plan_courses)


def reference(major="测试专业", rows=None):
    return {"年级": "2026", "方案": [{"年级": "2026", "专业": major,
        "毕业最低学分": None, "专业限选最低学分": None,
        "课程": rows if rows is not None else [{"课程号": "000001", "课程名称标识": "测试课程", "课程性质": "计算机限选", "学分": "2", "开课时间": "第2学期"}]}]}


class ReferencePlan2026Test(unittest.TestCase):
    def test_append_only_reference_does_not_mutate_or_copy_old_quota(self):
        old = [{"年级": "2025", "专业": "测试专业", "毕业最低学分": 160, "专业限选最低学分": 20, "课程": []}]
        before = copy.deepcopy(old)
        merged = merge_2026_course_reference(old, reference())
        self.assertEqual(old, before)
        self.assertEqual(merged[0], before[0])
        req = build_major_requirements(merged)[1]
        self.assertIsNone(req["minTotal"])
        self.assertIsNone(req["minMajorElective"])
        self.assertTrue(req["isPartial"])
        self.assertEqual(req["byNature"], {})

    def test_complete_existing_2026_plan_wins_and_empty_plan_not_created(self):
        old = [{"年级": "2026", "专业": "测试专业", "课程": [], "毕业最低学分": 160}]
        self.assertEqual(merge_2026_course_reference(old, reference()), old)
        self.assertEqual(merge_2026_course_reference([], reference(rows=[])), [])

    def test_scope_native_nature_and_existing_credit_definition(self):
        old = [{"年级": "2025", "专业": "其他专业", "课程": [
            {"课程号": "000001", "课程名称标识": "旧正式名称", "课程性质": "专业任选", "学分": "3"}]}]
        plans, natures, _, credits, names = parse_training_plan(merge_2026_course_reference(old, reference()))
        self.assertEqual([p["year"] for p in plans["000001"] if p["nature"] == "计算机限选"], ["2026"])
        self.assertEqual(credits["000001"], 3)
        self.assertEqual(names["000001"], "旧正式名称")
        self.assertIn("计算机限选", natures["000001"])

    def test_wrong_grade_and_duplicate_major_rejected(self):
        bad = reference();bad["方案"][0]["年级"] = "2025"
        with self.assertRaises(ValueError):merge_2026_course_reference([], bad)
        bad = reference();bad["方案"] *= 2
        with self.assertRaises(ValueError):merge_2026_course_reference([], bad)

    def test_actual_file_coverage_and_unknown_requirements(self):
        merged = load_training_plan()
        refs = [p for p in merged if p.get("仅课程性质参考")]
        self.assertEqual(len(refs), 129)
        self.assertEqual(sum(len(p["课程"]) for p in refs), 10413)
        req = [r for r in build_major_requirements(merged) if r["year"] == "2026"]
        self.assertTrue(all(r["minTotal"] is None and r["minMajorElective"] is None and r["isPartial"] for r in req))
        self.assertEqual(len(build_plan_courses(merged)), 1283)
        original = json.loads(Path("data/master_raw/training_plan.json").read_text())
        self.assertEqual(merged[:len(original)], original)


if __name__ == "__main__":unittest.main()
