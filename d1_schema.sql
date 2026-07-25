-- D1 Schema for JXNU选课PLUS
-- Run in Cloudflare Dashboard > D1 > your database > Console
-- Or:  npx wrangler d1 execute jxnu-reviews --remote --file=d1_schema.sql

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
--   { planningSemester: string, noSchedule: boolean,
--     scheduleItems: [{courseId, courseName, teacher?, classroom?, schedule?, credits?, ...}],
--     detailCourses: [{courseId, courseName, credits, nature?, planTermIndex?, semester?, ...}] }
-- 注意：这张表住在**独立的 D1 库 jxnu-students**（绑定 DB_STUDENTS），不在
-- jxnu-ratings 里。它有 28818 行 / 289MB，而评价数据只有 0.4MB；D1 按页从远端惰性
-- 拉取，同库时评价查询要为这堆数据的体量买单（同一条评价列表语句 D1 自报
-- sql_duration_ms=0.8，HTTP 却要 26s）。建表用：
--   npx wrangler d1 execute jxnu-students --remote --file=d1_schema.sql
CREATE TABLE IF NOT EXISTS student_records (
  student_id   TEXT PRIMARY KEY,
  class_name   TEXT,
  plan_key     TEXT,
  total_earned REAL,
  taken_count  INTEGER,
  record_json  TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 站点级开关（key-value）。评价/举报/学号人机验证都由 Go 面板写入，改完即生效、不需重新部署：
--   review_moderation       = 'on'|'off'  审核模式（新评价是否先进 pending）
--   captcha_provider        = 'off'|'turnstile'|'cap'（二选一，互斥）
--   captcha_reviews_enabled = 'on'|'off'  是否保护评价提交
--   captcha_reports_enabled = 'on'|'off'  是否保护举报提交
--   captcha_student_enabled = 'on'|'off'  是否保护学号查询
--   turnstile_site_key / turnstile_secret = Turnstile 公钥/服务端密钥
--   cap_api_endpoint / cap_site_key / cap_secret = Cap 自托管地址/站点密钥/验证密钥
--   cap_wasm_url            = 可选的自托管 WASM 地址（空则按 Cap 地址推导）
-- 为什么 turnstile 不用 Pages 环境变量：仓库带 wrangler.toml 时每次 git 构建会清掉不在 [vars]
-- 里的明文变量，而本仓库每小时被数据同步 push→构建一次，明文站点密钥最多活一小时。
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- AI帮我选 用量记账（functions/api/ai/recommend.ts）。
-- 配额原子预扣：INSERT .. ON CONFLICT DO UPDATE SET calls=calls+1 RETURNING calls，先扣再判防并发绕过。
-- scope = 'voter:<uuid>'（per 用户日配额）| 'site'（全站日 calls 上限 + token 熔断）。
-- 不含任何可与 student_records 关联的字段（无学号、无 IP）。
CREATE TABLE IF NOT EXISTS ai_usage (
  day    TEXT NOT NULL,
  scope  TEXT NOT NULL,
  calls  INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);
