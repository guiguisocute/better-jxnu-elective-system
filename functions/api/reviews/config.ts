interface Env {
  DB: D1Database;
  /** 兼容兜底（本地 .dev.vars 开发用）。生产开关在 D1 app_settings.turnstile_site_key ——
   *  不能用 Pages 环境变量：仓库带 wrangler.toml 时每次 git 构建会把不在 toml [vars] 里的
   *  明文变量清掉（本仓库每小时被 VPS 数据同步 push 一次，明文变量最多活一小时）。 */
  TURNSTILE_SITE_KEY?: string;
}

// GET /api/reviews/config — 前端运行时配置。
// turnstileSiteKey 非空 = 发表评价需过 Cloudflare Turnstile 人机校验（与 turnstile_secret 成对，
// 由 Go 后台面板「评价管理」页写入 D1，即改即生效，无需重新部署）。

export const onRequestGet: PagesFunction<Env> = async (context) => {
  let siteKey = "";
  try {
    const row = await context.env.DB
      .prepare("SELECT value FROM app_settings WHERE key = 'turnstile_site_key'")
      .first<{ value: string }>();
    siteKey = row?.value?.trim() ?? "";
  } catch {
    /* app_settings 表缺失（本地空库）→ 视为未启用 */
  }
  if (!siteKey) siteKey = context.env.TURNSTILE_SITE_KEY?.trim() ?? "";
  return Response.json(
    { turnstileSiteKey: siteKey },
    // 60s：开关翻转后前端最多一分钟内跟上（面板改 D1 即生效，不用等部署）
    { headers: { "Cache-Control": "max-age=60" } }
  );
};
