-- 举报表增量迁移（幂等）。
-- 本地:  npx wrangler d1 execute jxnu-reviews --local  --file=d1_reviews_reports_migrate.sql
-- 远端:  npx wrangler d1 execute jxnu-reviews --remote --file=d1_reviews_reports_migrate.sql
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
