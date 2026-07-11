// 开发者级功能开关（无 UI，改这里即生效）—— 编译期「总闸」：
// 设 false 时无条件关闭，运行时配置无法再打开；设 true 时实际值 = 总闸 && appConfig.featureFlags.*
// （运行时值来自 data/build_config.json → public/app_config.json，后台 GUI 可改，见 src/lib/appConfig.ts）。

/** 学号一键导入（引导模式内的二级页入口）。设 false 即隐藏入口、停用该功能。 */
export const STUDENT_IMPORT_ENABLED = true;

/** AI帮我选（SimPanel 第 4 个 tab）。设 false 即隐藏入口、停用该功能（后端另有 AI_API_KEY 未配置 → 501 的双保险）。 */
export const AI_PICK_ENABLED = true;
