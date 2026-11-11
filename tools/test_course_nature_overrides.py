import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_data import (apply_course_nature_overrides, load_course_nature_overrides,
                        parse_training_plan, build_plan_courses,
                        build_search_course, build_sections_for_semester)

TAG = "计算机限选"


def fixture():
    # 测试夹具不写入真实课程数据。
    return [{"id": "000001", "name": "测试课程甲", "tags": ["专业任选"], "plans": []},
            {"id": "000002", "name": "测试课程乙", "tags": [], "plans": []}]


class CourseNatureOverridesTest(unittest.TestCase):
    def load(self, raw):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mapping.json"
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            return load_course_nature_overrides(path)

    def test_empty_mapping_is_noop(self):
        courses = fixture()
        before = copy.deepcopy(courses)
        apply_course_nature_overrides(courses, self.load({"version": 1, "byCourseId": {}, "byCourseName": {}}))
        self.assertEqual(courses, before)

    def test_id_preserves_leading_zeros_and_does_not_change_plans(self):
        courses = fixture()
        mapping = self.load({"version": 1, "byCourseId": {"000001": [TAG]}})
        apply_course_nature_overrides(courses, mapping)
        apply_course_nature_overrides(courses, mapping)
        self.assertEqual(courses[0]["id"], "000001")
        self.assertEqual(courses[0]["tags"], ["专业任选", TAG])
        self.assertEqual(courses[0]["extraNatureTags"], [TAG])
        self.assertEqual(courses[0]["plans"], [])
        self.assertNotIn(TAG, courses[1]["tags"])

    def test_unique_exact_name_and_id_precedence(self):
        courses = fixture()
        mapping = self.load({"version": 1, "byCourseId": {"000001": []},
                             "byCourseName": {"测试课程甲": [TAG], "测试课程乙": [TAG]}})
        apply_course_nature_overrides(courses, mapping)
        self.assertNotIn(TAG, courses[0]["tags"])
        self.assertIn(TAG, courses[1]["tags"])

    def test_unknown_or_ambiguous_courses_fail_without_partial_mutation(self):
        for field, key in [("byCourseId", "missing"), ("byCourseName", "不存在"), ("byCourseName", "测试课程甲")]:
            courses = fixture()
            if key == "测试课程甲":
                courses[1]["name"] = key
            before = copy.deepcopy(courses)
            mapping = {"version": 1, "byCourseId": {"000001": [TAG]}, field: {key: [TAG]}}
            with self.assertRaises(ValueError):
                apply_course_nature_overrides(courses, mapping)
            self.assertEqual(courses, before)

    def test_bad_mapping_is_rejected(self):
        for raw in [[], {"version": 2}, {"version": 1, "byCourseId": []},
                    {"version": 1, "byCourseId": {" 000001": [TAG]}},
                    {"version": 1, "byCourseId": {"000001": "计算机限选"}},
                    {"version": 1, "byCourseId": {"000001": ["猜测标签"]}},
                    {"version": 1, "unknown": {}}]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.load(raw)

    def test_school_native_nature_roundtrips(self):
        raw = [{"年级": "2099", "专业": "测试专业", "课程": [
            {"课程号": "000001", "课程性质": TAG, "课程名称标识": "测试课程甲", "学分": "2"}]}]
        plans, natures, _, _, _ = parse_training_plan(raw)
        self.assertEqual(plans["000001"][0]["nature"], TAG)
        self.assertEqual(natures["000001"], {TAG})
        self.assertEqual(build_plan_courses(raw)["2099级-测试专业"][0]["nature"], TAG)

    def test_formal_sections_inherit_confirmed_tags(self):
        courses = fixture()
        apply_course_nature_overrides(courses, {"byCourseId": {"000001": [TAG]}})
        sections = build_sections_for_semester(
            [{"课程号": "000001", "班级号": "test", "任课教师": "测试老师"}],
            {c["id"]: c for c in courses}, {}, "2099-03")
        self.assertIn(TAG, sections[0]["tags"])
        self.assertIn(TAG, sections[0]["_search"])

    def test_appended_tag_is_searchable(self):
        courses = fixture()
        apply_course_nature_overrides(courses, {"byCourseId": {"000001": [TAG]}})
        course = {**courses[0], "englishName": "", "dept": ""}
        self.assertIn(TAG, build_search_course(course, []))


if __name__ == "__main__":
    unittest.main()
