-- 审核模式增量迁移（针对已按旧 schema 建过 reviews 的库；新库直接跑 d1_reviews_schema.sql 即可）。
-- 注意：ALTER TABLE ADD COLUMN 不幂等，本文件只应执行一次。
-- 本地:  npx wrangler d1 execute jxnu-reviews --local  --file=d1_reviews_moderation_migrate.sql
-- 远端:  npx wrangler d1 execute jxnu-reviews --remote --file=d1_reviews_moderation_migrate.sql
ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
