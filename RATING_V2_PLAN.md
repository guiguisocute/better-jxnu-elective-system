# RATING_V2_PLAN.md — 评价系统 V2 开发文档

> 最后更新：2026-07-24。**已全部实现并验证**；本文档保留为架构说明 + 运维手册。

## 一句话背景
旧评分系统只有单一五星分、星级散落在列表页。V2 全重写：列表页删星级（仅详情页 + 独立子页面展示）、5 维度评分（总体/考核给分/考勤频率/课程难度/教学质量，每星有文案、每维度可选评语）、匿名头像+昵称、「有用」投票，Go 后台面板直连 D1 增删改查监管。UI 按 `plan/课程评价 V2 设计稿/` 还原。

## 核心决策（已落地）
- **宽表 schema**：一行 = 一个 voter 对 (course, teacher) 的完整评价，`UNIQUE(course_id,teacher_id,voter_id)`，POST = 整行 upsert 覆盖。
- 旧 `ratings` 迁入 `reviews.overall`；旧表只读保留。旧 `/api/ratings*` 端点兼容期保留但内部读写 `reviews.overall`（避免双写）。
- **前端无删除入口**：删改监管一律走 Go 后台面板；用户重新提交即覆盖。
- 头像 = momo 风 emoji+柔和底色，由 seed 确定性渲染（`src/lib/avatar.ts`）；`avatar` 字段只存 seed，日后可无缝换图包。
- 列表页评分列与「评分排序」一并删除；正选排序退化为 学分/余量；AI `ratingOf` 改喂 `useAllReviews().getTeacherOverall`。

## 数据层
- `d1_reviews_schema.sql` — `reviews`（5 分数列 + 5 评语列 `*_c` + avatar/nickname + created/updated_at）+ `review_votes`（有用投票，PK (review_id, voter_id)，toggle 语义）。
- `d1_reviews_migrate.sql` — `INSERT OR IGNORE ... SELECT ... FROM ratings`，幂等。
- 分数 0.5–5 步进 0.5、评语 ≤500、昵称 ≤20、avatar seed ≤64，全部在 API 层校验。

## API（functions/api/，契约镜像 `src/lib/reviewDimensions.ts`，改形状两侧手动同步）
| 端点 | 说明 |
|---|---|
| `GET /api/reviews?courseId=` | 每教师 5 维聚合 `{teacher_id, dims:{overall:{avg,count},...}}[]` |
| `POST /api/reviews` | 匿名 upsert（≥1 维非空；无公开 DELETE） |
| `GET /api/reviews/all` | 全站聚合 `{cid:{tid:dims}}`（子页面 bulk-load + 排序/AI 的 overall 源） |
| `GET /api/reviews/comments?courseId/teacherId&voterId&limit&offset` | 评语流（helpful 计数、mine/myVote 标记） |
| `GET /api/reviews/mine?courseId&teacherId&voterId` | 本人评价回填 |
| `POST /api/reviews/helpful` | 有用投票 toggle |
| `GET/POST/DELETE /api/ratings*` | 兼容旧客户端，读写 `reviews.overall` |

## 前端
- 契约/常量：`src/lib/reviewDimensions.ts`（维度、星级文案、配色、`compositeOf` 综合分 = 4 新维度等权平均）。
- 数据层：`src/lib/reviewsStore.ts`（module pub/sub，POST 响应权威聚合直接覆盖）+ `src/hooks/useReviews.ts`（`useAllReviews`/`useCourseReviews`/`useReviewComments`）。
- 子页面 `/ratings`（`src/components/RatingsPage.tsx` + `components/ratings/`）：按课程/按老师双视图、搜索、最新/最有帮助/好评优先排序、教师综合分面板+5 维彩条（`DimensionBars`）、评价卡（`ReviewCard`：头像昵称/热评/维度胶囊/分维评语块/有用）、写评价面板（`RatingSheet`：头像换一个+昵称+每维星级实时文案+可选评语）。入口：首页红条「课程评价」。
- 详情页 `CourseDetail`/`FormalSectionDetail`：每教师 5 维彩条 + 写评价 + 「查看全部评价 →」链到 /ratings。
- `QuickRatingPanel`：保留学号导入快评，仅打 overall（提交前回读 mine 保住其他维度）。
- 列表 `CourseTable`：预选表 6+1 列、正选表 10 列，评分列/排序按钮已全删。

## Go 后台（backend/internal/app/）
- `config.go`：`CF_D1_DATABASE_ID`（默认 = wrangler.toml 的库 id）。
- `cloudflare.go`：`D1Query(ctx, sql, params)` → `POST /accounts/{acct}/d1/database/{db}/query`，全参数化；**Token 需补 Account / D1 / Edit 权限**。
- `admin_reviews.go`：`/reviews` 列表（分页 20/页、按课程号/教师号/voter 搜索、统计卡）、`/reviews/edit`（新增/编辑全字段）、action `save-review` / `delete-review` / `purge-reviews`（按 voter/teacher 精确批量删+孤儿投票清理）。全部走既有 auth+CSRF；nav 加「评价管理」。

## 验证（全部已跑通）
- `npx tsc -b`、`npm run build`、`npm run lint`、`cd backend && go build ./... && go vet ./... && go test ./...` 全绿。
- **端到端验证程序** `tools/verify_reviews_api.mjs`（24 断言：校验/聚合/回填/覆盖/投票/兼容端点/自清理）：
  ```bash
  npx wrangler d1 execute jxnu-ratings --local --file=d1_reviews_schema.sql
  npx wrangler d1 execute jxnu-ratings --local --file=d1_reviews_migrate.sql
  npx wrangler pages dev --port 8788   # 另一终端
  node tools/verify_reviews_api.mjs http://127.0.0.1:8788
  ```
  线上冒烟：`node tools/verify_reviews_api.mjs https://<生产域名>`（写入用例用 verify- 前缀 voter，会自清理；剩余痕迹可在后台面板搜 voter=verify- 清）。

## 部署 SOP
1. **远端 D1 迁移**（先于前端上线）：
   ```bash
   npx wrangler d1 execute jxnu-ratings --remote --file=d1_reviews_schema.sql
   npx wrangler d1 execute jxnu-ratings --remote --file=d1_reviews_migrate.sql
   npx wrangler d1 execute jxnu-ratings --remote --command "SELECT (SELECT COUNT(*) FROM ratings) old,(SELECT COUNT(*) FROM reviews) new"
   ```
2. push main → CF Pages 自动部署前端 + Functions。
3. **VPS Go 后端**：`git pull` → `go build -o ~/apps/jxnu-backend/jxnu-backend ./backend/cmd/jxnu-backend` → `systemctl --user restart jxnu-backend`。
4. **人工步骤**：CF API Token 补 D1 Edit 权限（否则 /reviews 页会报权限错误）；SSH 隧道登面板核对评价管理页。

## 风险与注意
- StarRating 勿改回 linearGradient（iOS Safari 半星 bug）。
- functions/ 不在 tsc -b 范围，改 API 形状须与 `reviewDimensions.ts` 手动同步。
- wrangler 本地 D1 与 remote 分离，两侧 schema 都要执行；勿把 wrangler 加进 devDeps。
- QuickRatingPanel 覆盖提交前必须回读 mine，否则会把用户在 /ratings 填的其他维度冲掉（已实现）。
