// 跳转学校选课系统的链接拼装。
//
// 选课系统按阶段分目录（预选/正选/补退选各自一个 StepN），阶段一换，旧的 StepN
// 页面就关掉了。阶段前缀由后端 /api/config 的 selectionStep 下发（后端从容量嗅探
// URL 派生，运维在面板切阶段时一处改动、这里自动跟随），不再硬编码在组件里——
// 2026-09 补退选开门后，写死的 Step3 链接就把人送去了已关闭的正选页面。
const XK_BASE = "https://xk.jxnu.edu.cn";

/**
 * 「点击跳转此课程选课界面」的地址。
 *
 * step 取不到（后端不可达、或运维还没改嗅探 URL）时回落到 fallback，
 * 行为与接入运行时配置之前完全一致——宁可给个旧链接，也不给个坏链接。
 */
export function selectCourseURL(step: string, courseId: string, fallback = "Step3"): string {
  const prefix = /^Step[1-9]$/.test(step) ? step : fallback;
  return `${XK_BASE}/${prefix}/AddCourse.aspx?kch=${encodeURIComponent(courseId)}`;
}
