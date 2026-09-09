import { compressTag, tagColorClasses } from "../lib/tagColors";

/**
 * 课程标签徽章。
 *
 * compact：表格窄列专用 —— 缩写文案（compressTag）+ 更窄内边距，
 * 真放不下时在**药丸内部**用省略号截断，边框/圆角保持完整。
 *
 * 截断必须由徽章自己完成：原先是在外面套一层 `<span class="max-w-full truncate">`，
 * 但那层是 display:inline —— max-width / overflow / text-overflow 对非替换行内盒全都不生效，
 * 于是徽章原样溢出、再被父级 overflow-hidden 齐刷刷切掉（右边框和半个字一起没了）。
 * 非 compact 分支保持纯文本（不套内层 span）：overflow:hidden 的盒子会改变基线，
 * 详情页里徽章与相邻行内文字的对齐会跟着抖。
 */
export function TagBadge({ tag, compact = false }: { tag: string; compact?: boolean }) {
  return (
    <span
      title={compact ? tag : undefined}
      className={`inline-flex shrink-0 whitespace-nowrap py-0.5 rounded-md text-[11px] font-medium border ${
        compact ? "max-w-full px-1.5" : "px-2"
      } ${tagColorClasses(tag)}`}
    >
      {compact ? <span className="truncate">{compressTag(tag)}</span> : tag}
    </span>
  );
}
