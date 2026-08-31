// 引用计数的 body 滚动锁:多个浮层叠开时(抽屉+详情、引导+面板),
// 最后一个释放才恢复滚动,避免各浮层各自 save/restore 的竞态互踩。
// html+body 双设 overflow:hidden —— 仅设 body 在 iOS Safari 上锁不住;
// html 再加 overscrollBehavior:none 压掉滚动到底后的链式橡皮筋。
let count = 0;
let saved: {
  htmlOverflow: string;
  bodyOverflow: string;
  htmlOverscroll: string;
  bodyPaddingRight: string;
  scrollY: number;
} | null = null;

export function acquireScrollLock(): () => void {
  if (count === 0) {
    const html = document.documentElement;
    // 上锁前记住滚动位置。overflow:hidden 让文档失去可滚动区域，浏览器随即把
    // scrollTop 夹到 0；不记下来，用户滚到半页点开模拟选课，关掉浮层就回到页首。
    const scrollY = window.scrollY;
    // 滚动条撤掉会让内容整体右移一个滚动条宽度。用等宽 padding 补回去，
    // 否则每次开关浮层整页都横跳一下（宽屏尤其明显）。
    // innerWidth 含滚动条、clientWidth 不含，差值就是要补的宽度；
    // 覆盖式滚动条（移动端/macOS 默认）差值为 0，不会多加 padding。
    const gutter = window.innerWidth - html.clientWidth;
    saved = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: document.body.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
      bodyPaddingRight: document.body.style.paddingRight,
      scrollY,
    };
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
    if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;
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
      document.body.style.paddingRight = saved.bodyPaddingRight;
      // 必须等 overflow 恢复、文档重新可滚动之后再回到原位置，
      // 否则这次 scrollTo 同样会被夹成 0。
      window.scrollTo(0, saved.scrollY);
      saved = null;
    }
  };
}
