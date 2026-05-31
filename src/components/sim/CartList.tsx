import { useState } from "react";
import type { Course } from "../../types";
import { TagBadge } from "../TagBadge";
import { courseNature } from "../../lib/creditPlan";
import { copyText } from "../../lib/clipboard";

interface SectionInfo {
  className?: string;
  placed: boolean;
}

interface Props {
  courses: Course[];
  selectedPlan: string;
  onRemove: (id: string) => void;
  /** cid → 落格班级信息（来自周课表选班结果）。 */
  sectionInfo?: Record<string, SectionInfo>;
  /** 轻提示回调（复制成功等）。 */
  onNotify?: (msg: string) => void;
  /** 点击课程 → 详情页切到该课。 */
  onSelect?: (course: Course) => void;
  /** 当前详情页打开的课程号 → 高亮该行。 */
  selectedId?: string;
}

function getCreditColor(credits: number): string {
  // 同 CourseTable.getCreditColor：亮色凡被 index.css 全局 .dark 补丁映射的红色档位改用 arbitrary hex 绕过，
  // 确保 dark: 变体能干净覆盖（详见 CourseTable 注释）。
  if (credits <= 1) return "bg-[#FEF2F2] text-red-400 dark:bg-[#7F1D1D]/40 dark:text-[#FCA5A5]";
  if (credits <= 2) return "bg-[#FEE2E2] text-[#DC2626] dark:bg-[#7F1D1D]/55 dark:text-[#FECACA]";
  if (credits <= 3) return "bg-[#FEE2E2] text-[#DC2626] dark:bg-[#7F1D1D]/70 dark:text-[#FECACA]";
  if (credits <= 4) return "bg-[#FECACA] text-[#B91C1C] dark:bg-[#991B1B]/85 dark:text-[#FEE2E2]";
  return "bg-[#FCA5A5] text-[#991B1B] dark:bg-[#B91C1C]/90 dark:text-white";
}

// 公选课无固定班级（统一开课）。
function isGongxuan(c: Course): boolean {
  return c.tags.some((t) => t === "公选课" || t.startsWith("公选课-"));
}

function classText(c: Course, info?: SectionInfo): string {
  if (info?.className && info.className.trim()) return `班级 ${info.className}`;
  if (isGongxuan(c)) return "公选课 · 无固定班级";
  if (info && !info.placed) return "课表待发布";
  return "班级待定";
}

export function CartList({ courses, selectedPlan, onRemove, sectionInfo, onNotify, onSelect, selectedId }: Props) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (id: string) => {
    const ok = await copyText(id);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200);
      onNotify?.(`已复制课程号 ${id}`);
    } else {
      onNotify?.("复制失败，请手动复制");
    }
  };

  if (courses.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center">
        <div className="text-[12px] text-gray-400">待选清单空空如也</div>
        <div className="text-[11px] text-gray-300 mt-0.5">
          在课程详情页“加入待选清单”开始
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {courses.map((c) => {
        const info = sectionInfo?.[c.id];
        const copied = copiedId === c.id;
        return (
          <div
            key={c.id}
            onClick={() => onSelect?.(c)}
            className={`rounded-lg border transition-colors p-2 flex items-center gap-2.5 ${onSelect ? "cursor-pointer" : ""} ${
              selectedId === c.id ? "border-red-400 bg-red-50 ring-1 ring-red-200" : "border-gray-100 hover:border-red-200"
            }`}
          >
            <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-bold shrink-0 ${getCreditColor(c.credits)}`}>
              {c.credits}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-gray-800 truncate">{c.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-gray-400">
                <span className="font-mono text-gray-500">{c.id}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleCopy(c.id); }}
                  title="复制课程号"
                  className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors ${
                    copied ? "text-green-500" : "text-gray-300 hover:text-gray-600"
                  }`}
                >
                  {copied ? (
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  ) : (
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                  )}
                </button>
                <span className="text-gray-300">·</span>
                <span className="truncate">{classText(c, info)}</span>
              </div>
            </div>
            <TagBadge tag={courseNature(c, selectedPlan)} />
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(c.id); }}
              title="移出待选清单"
              className="text-gray-300 hover:text-rose-500 shrink-0"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
