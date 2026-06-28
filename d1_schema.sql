-- D1 Schema for JXNU选课PLUS
-- Run in Cloudflare Dashboard > D1 > your database > Console
-- Or:  npx wrangler d1 execute jxnu-ratings --remote --file=d1_schema.sql

-- 教师评分（每 voter 每 (course, teacher) 一条；upsert 走 ON CONFLICT）
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  rating REAL NOT NULL,
  voter_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_id, teacher_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_course ON ratings(course_id);
CREATE INDEX IF NOT EXISTS idx_ratings_teacher ON ratings(teacher_id);
CREATE INDEX IF NOT EXISTS idx_ratings_course_teacher ON ratings(course_id, teacher_id);

-- 学生档案（blob-per-student；按 studentId 查一行带回 planKey/已修学分/已修课程 + 课表）
-- 脱敏：不存姓名（去标识化）。仅凭学号查询；class_name 用于方案推断（含年级专业，非 PII）。
-- record_json 形状对齐 src/lib/studentRecord.ts 的 StudentRecord：
--   { noSchedule: boolean,
--     scheduleItems: [{courseId, courseName, teacher?, classroom?, schedule?, credits?, ...}],
--     detailCourses: [{courseId, courseName, credits, nature?, planTermIndex?, semester?, ...}] }
CREATE TABLE IF NOT EXISTS student_records (
  student_id   TEXT PRIMARY KEY,
  class_name   TEXT,
  plan_key     TEXT,
  total_earned REAL,
  taken_count  INTEGER,
  record_json  TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
