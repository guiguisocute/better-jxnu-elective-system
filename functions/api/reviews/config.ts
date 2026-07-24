interface Env {
  TURNSTILE_SITE_KEY?: string;
}

// GET /api/reviews/config — 前端运行时配置。
// turnstileSiteKey 非空 = 发表评价需过 Cloudflare Turnstile 人机校验（与后端 TURNSTILE_SECRET 成对配置）。

export const onRequestGet: PagesFunction<Env> = async (context) => {
  return Response.json(
    { turnstileSiteKey: context.env.TURNSTILE_SITE_KEY?.trim() ?? "" },
    { headers: { "Cache-Control": "max-age=300" } }
  );
};
