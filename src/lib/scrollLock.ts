// 引用计数的 body 滚动锁:多个浮层叠开时(抽屉+详情、引导+面板),
// 最后一个释放才恢复滚动,避免各浮层各自 save/restore 的竞态互踩。
// html+body 双设 overflow:hidden —— 仅设 body 在 iOS Safari 上锁不住;
// html 再加 overscrollBehavior:none 压掉滚动到底后的链式橡皮筋。
let count = 0;
let saved: { htmlOverflow: string; bodyOverflow: string; htmlOverscroll: string } | null = null;

export function acquireScrollLock(): () => void {
  if (count === 0) {
    const html = document.documentElement;
    saved = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: document.body.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
    };
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
  }
  count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count--;
    if (count === 0 && saved) {
      const html = document.documentElement;
      html.style.overflow = saved.htmlOverflow;
      document.body.style.overflow = saved.bodyOverflow;
      html.style.overscrollBehavior = saved.htmlOverscroll;
      saved = null;
    }
  };
}
