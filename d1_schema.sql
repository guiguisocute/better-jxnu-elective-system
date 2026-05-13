-- D1 Schema for JXNU选课PLUS ratings
-- Run this in Cloudflare Dashboard > D1 > your database > Console

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
