import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

// 评价卡瀑布流。取代原来的 CSS `columns-2`：多列布局是**列优先**填充的
// （前 N 条全堆左列、剩下的才进右列），最新的几条会挤在同一侧，读起来不像时间流。
// 这里改成 JS 分列，按下标 0→左 1→右 一左一右轮流放，阅读顺序即时间顺序。
//
// 顺带做渲染层懒加载：广场一次拿 100 条评价，一口气渲染 100 张卡（每张含维度条 /
// 星星 / 多段评语）是首屏的大头。先渲染 pageSize 条，哨兵进视口再追加一页。

const TWO_COL = "(min-width: 1280px)"; // == tailwind xl，与原 `xl:columns-2` 断点一致

interface Props<T> {
  items: T[];
  keyOf: (item: T) => string | number;
  renderItem: (item: T) => ReactNode;
  /** 变化时回到第一屏（排序/选中对象切换）。**不要**挂 items 本身 ——
   *  点「有用」会刷新整个 rows 数组，那样每点一次赞就把已展开的卡片全收回去。 */
  resetKey: string;
  pageSize?: number;
}

export function ReviewMasonry<T>({ items, keyOf, renderItem, resetKey, pageSize = 12 }: Props<T>) {
  const [cols, setCols] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(TWO_COL).matches ? 2 : 1,
  );
  useEffect(() => {
    const mq = window.matchMedia(TWO_COL);
    const sync = () => setCols(mq.matches ? 2 : 1);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const [limit, setLimit] = useState(pageSize);
  useEffect(() => {
    setLimit(pageSize);
  }, [resetKey, pageSize]);

  const sentinel = useRef<HTMLDivElement | null>(null);
  const hasMore = limit < items.length;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    // rootMargin：提前一屏开始加载，正常速度滚动时看不到"加载更多"这行字
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + pageSize);
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, pageSize]);

  const columns: T[][] = Array.from({ length: cols }, () => []);
  items.slice(0, limit).forEach((item, i) => columns[i % cols].push(item));

  return (
    <>
      <div className="flex flex-col xl:flex-row items-start gap-4">
        {columns.map((col, ci) => (
          <div key={ci} className="w-full xl:flex-1 min-w-0 flex flex-col gap-4">
            {col.map((item) => (
              <Fragment key={keyOf(item)}>{renderItem(item)}</Fragment>
            ))}
          </div>
        ))}
      </div>
      {hasMore && (
        <div ref={sentinel} className="py-6 text-center text-[12px] text-gray-400">
          加载更多评价…
        </div>
      )}
    </>
  );
}
