-- 评价系统 V2 schema（宽表：一行 = 一个 voter 对 (course, teacher) 的完整评价）
-- 本地:  npx wrangler d1 execute jxnu-ratings --local  --file=d1_reviews_schema.sql
-- 远端:  npx wrangler d1 execute jxnu-ratings --remote --file=d1_reviews_schema.sql
--
-- 5 个维度固定列（overall=总体评分 承接旧 ratings.rating；assess=考核给分;
-- attendance=考勤频率; difficulty=课程强度; teaching=教学质量），全部可空 ——
-- 用户可以只评在意的维度。每维度各带一条可选评语（*_c 列）。
-- 分数取值 0.5–5 步进 0.5，在 API 层校验（D1/SQLite 不便按维度 CHECK NULL 组合）。

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  voter_id   TEXT NOT NULL,
  avatar     TEXT,             -- 匿名头像种子（前端本地确定性渲染）
  nickname   TEXT,             -- 匿名昵称（可空，展示层兜底「匿名同学」）
  overall    REAL,
  assess     REAL,
  attendance REAL,
  difficulty REAL,
  teaching   REAL,
  overall_c    TEXT,
  assess_c     TEXT,
  attendance_c TEXT,
  difficulty_c TEXT,
  teaching_c   TEXT,
  -- 审核状态：approved（默认，直接公开）/ pending（审核模式开启时新提交）/ rejected。
  -- 公开读接口只出 approved；审核在 Go 后台面板进行。
  status     TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_id, teacher_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_course  ON reviews(course_id);
CREATE INDEX IF NOT EXISTS idx_reviews_ct      ON reviews(course_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_reviews_teacher ON reviews(teacher_id);
CREATE INDEX IF NOT EXISTS idx_reviews_voter   ON reviews(voter_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status  ON reviews(status);

-- 站点级开关（评价审核模式等）。key: review_moderation, value: 'on' | 'off'（缺省 off）。
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 评价举报（一人对一条评价一次）。status: open（待处理）/ resolved（已处理）。
-- Go 后台评价管理页展示未处理数与列表。
CREATE TABLE IF NOT EXISTS review_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  voter_id  TEXT NOT NULL,
  reason    TEXT,
  status    TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(review_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_review_reports_status ON review_reports(status);
CREATE INDEX IF NOT EXISTS idx_review_reports_review ON review_reports(review_id);

-- 「有用」投票（评价卡右下角 👍）。一人一票，重复 POST = 取消（toggle）。
CREATE TABLE IF NOT EXISTS review_votes (
  review_id INTEGER NOT NULL,
  voter_id  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (review_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_review_votes_review ON review_votes(review_id);
