-- 旧单一评分 → 新表 overall 维度（幂等：重复执行靠 UNIQUE + OR IGNORE 跳过）。
-- 先跑 d1_reviews_schema.sql 再跑本文件。旧 ratings 表保留只读，不删。
INSERT OR IGNORE INTO reviews (course_id, teacher_id, voter_id, overall, created_at, updated_at)
SELECT course_id, teacher_id, voter_id, rating, created_at, created_at
FROM ratings;
