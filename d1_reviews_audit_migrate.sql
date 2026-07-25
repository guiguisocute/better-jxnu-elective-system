-- 评价「回收站」+「操作日志」增量迁移（幂等，可重复执行）。
--
-- Go 后台 (backend/internal/app/d1warm.go: ensureReviewOpsTables) 在启动后会自动
-- 执行同样的建表语句，正常情况下**不需要**手工跑这个文件；保留它是为了 schema 有
-- 一处可读的权威定义，以及在没有面板的环境里手动建表。
--
-- 本地:  npx wrangler d1 execute jxnu-ratings --local  --file=d1_reviews_audit_migrate.sql
-- 远端:  npx wrangler d1 execute jxnu-ratings --remote --file=d1_reviews_audit_migrate.sql

-- 回收站：评价删除改为「先快照、再删」。payload 是删除瞬间 reviews 整行的 JSON
-- 快照，votes 是它的 review_votes 快照，因此还原可以把评价连同「有用」票一起复原。
-- restored_at 非空 = 已还原（保留记录，不物理删除，便于溯源）。
CREATE TABLE IF NOT EXISTS review_trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id  INTEGER NOT NULL,   -- 原 reviews.id
  course_id  TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  voter_id   TEXT NOT NULL,
  payload    TEXT NOT NULL,      -- 整行 JSON 快照
  votes      TEXT,               -- review_votes 快照（JSON 数组）
  deleted_by TEXT NOT NULL,      -- 操作者
  source     TEXT NOT NULL,      -- manual / report / purge
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  restored_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_review_trash_deleted ON review_trash(deleted_at);
CREATE INDEX IF NOT EXISTS idx_review_trash_review  ON review_trash(review_id);
CREATE INDEX IF NOT EXISTS idx_review_trash_open    ON review_trash(restored_at);

-- 操作日志：面板上每一次会改变评价数据或站点开关的动作都留痕。
-- before/after 存 JSON（编辑类动作才有），detail 是给人看的一句话摘要。
-- 只记管理动作，不记密钥值。
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  before TEXT,
  after  TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_at     ON admin_audit(at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit(action);

-- 评价列表按 updated_at 倒序翻页，此前没有对应索引：SQLite 要全表扫 336 行再排序。
-- 行数本身微不足道，问题在于 D1 把数据库存在远端、按页惰性拉取，而这个库有 380MB
-- （student_records 占 289MB），于是「扫全表」= 拉一堆分散的远端页 = 单次请求 20~26s
-- （同一条语句 D1 自报 sql_duration_ms 只有 0.8）。有了这个索引只需读 20 行。
CREATE INDEX IF NOT EXISTS idx_reviews_updated ON reviews(updated_at DESC);
