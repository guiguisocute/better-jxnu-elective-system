import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_data as data


class PreselectionHistoryTest(unittest.TestCase):
    def test_calendar_semester_is_not_raw_offering_requirement(self):
        rows = data.build_preselection_courses(
            [{"课程号": "000001", "开课学期": "不限", "教师": []}],
            {"000001": {"id": "000001", "name": "测试课程", "englishName": "", "dept": "", "tags": []}},
            "2026-09")
        self.assertEqual(rows[0]["semester"], "2026-09")
        self.assertEqual(rows[0]["offeringTerm"], "不限")

    def test_actual_2026_catalog_restores_all_5928_courses(self):
        raw = json.loads(Path("data/semesters/2026-09/raw/preselect_catalog.json").read_text())
        manifest = json.loads(Path("public/data_manifest.json").read_text())
        rows = json.loads(Path("public" + manifest["preselectionCourses"]["2026-09"]).read_text())
        self.assertEqual(len(raw), 5928)
        self.assertEqual(len(rows), 5928)
        self.assertEqual({c["id"] for c in rows}, {c["课程号"] for c in raw})
        self.assertTrue(all(c["semester"] == "2026-09" and c["inPre"] for c in rows))
        self.assertTrue(all("desc" not in c and "prereqDesc" not in c for c in rows))

    def test_new_current_semester_does_not_remove_historical_catalog(self):
        semesters = data.load_semesters()
        for row in semesters.values():row["meta"]["isCurrent"] = False
        semesters["2027-03"]["meta"]["isCurrent"] = True
        semesters["2027-03"]["preselect_catalog"] = semesters["2026-09"]["preselect_catalog"][:1]
        master = {"courses": json.loads(Path("data/master/courses.json").read_text()),
                  "teachers": json.loads(Path("data/master/teachers.json").read_text()),
                  "reqs": json.loads(Path("data/master/major_requirements.json").read_text()),
                  "planCourses": json.loads(Path("data/master/plan_courses.json").read_text())}
        with tempfile.TemporaryDirectory() as tmp:
            paths = {k: str(Path(tmp) / Path(v).relative_to("public"))
                     for k, v in vars(data).items() if k.startswith("PUBLIC_") and isinstance(v, str)
                     and (v == "public" or v.startswith("public/"))}
            with patch.multiple(data, **paths):data.build_public(semesters, master)
            manifest = json.loads(Path(tmp, "data_manifest.json").read_text())
            self.assertEqual(set(manifest["preselectionCourses"]), {"2026-09", "2027-03"})
            old = json.loads((Path(tmp) / manifest["preselectionCourses"]["2026-09"].lstrip("/")).read_text())
            current = json.loads((Path(tmp) / manifest["courses"].lstrip("/")).read_text())
            self.assertEqual(len(old), 5928)
            self.assertEqual(len(current), 1, "do not aggregate historical catalogs into first-screen data")
            self.assertEqual(set(manifest["formalSections"]), {"2025-09", "2026-09"})


if __name__ == "__main__":unittest.main()
