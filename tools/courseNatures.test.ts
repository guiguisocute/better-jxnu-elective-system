import assert from "node:assert/strict";
import test from "node:test";
import { COURSE_NATURES, COURSE_TYPE_OPTIONS } from "../src/lib/courseNatures.ts";
import { displayTags } from "../src/lib/planMatch.ts";
import { compressTag, tagColorClasses } from "../src/lib/tagColors.ts";
import type { Course } from "../src/types.ts";

const course: Course = {
  id: "000001", name: "测试夹具", englishName: "", credits: 2, dept: "",
  semester: "2099-03", tags: ["计算机限选"], teachers: [], isDegreeCourse: false,
  plans: [{ year: "2099", major: "测试专业", direction: "", nature: "计算机限选", isDegree: false, semester: "" }],
  _search: "计算机限选",
};

test("new nature is a permanent filter option before courses are annotated", () => {
  assert.ok(COURSE_NATURES.includes("计算机限选"));
  assert.equal(COURSE_TYPE_OPTIONS.filter(t => t === "计算机限选").length, 1);
});
test("native nature follows selected plan scope", () => {
  assert.ok(displayTags(course, "2099级-测试专业").includes("计算机限选"));
  assert.ok(!displayTags(course, "2099级-其他专业").includes("计算机限选"));
});
test("confirmed supplemental nature remains visible across plans", () => {
  const annotated = { ...course, extraNatureTags: ["计算机限选"] as const };
  assert.ok(displayTags({ ...annotated, extraNatureTags: [...annotated.extraNatureTags] }, "2099级-其他专业").includes("计算机限选"));
  assert.ok(displayTags(course, "").includes("计算机限选"));
});
test("nature has a dedicated light/dark palette and keeps its full name", () => {
  const style = tagColorClasses("计算机限选");
  assert.ok(style.includes("dark:text-"));
  assert.ok(style.includes("dark:bg-"));
  assert.ok(style.includes("dark:border-"));
  assert.notEqual(style, tagColorClasses("未知性质"));
  assert.equal(compressTag("计算机限选"), "计算机限选");
});
