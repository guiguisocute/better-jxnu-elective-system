import assert from "node:assert/strict";
import test from "node:test";
import { preselectionSemesters, catalogForSemester } from "../src/lib/preselection.ts";

test("unpublished target remains first and past semesters remain selectable", () => {
  assert.deepEqual(preselectionSemesters("2027-03", ["2026-09", "2026-09", "invalid"]), ["2027-03", "2026-09"]);
  assert.deepEqual(preselectionSemesters("2027-03", []), ["2027-03"]);
});
test("old catalog and formal backfills cannot leak into pending preselection", () => {
  const old = { semester: "2026-09", inPre: true };
  const formal = { semester: "2027-03", inPre: false };
  assert.deepEqual(catalogForSemester([old, formal], "2027-03"), []);
  assert.deepEqual(catalogForSemester([old, formal], "2026-09"), [old]);
});
test("real catalog automatically replaces the pending state", () => {
  const fresh = { semester: "2027-03", inPre: true };
  assert.deepEqual(catalogForSemester([fresh], "2027-03"), [fresh]);
});
