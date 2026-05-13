import type { Course } from "../types";
import { TagBadge } from "./TagBadge";

interface Props {
  courses: Course[];
  selectedId?: string;
  onSelect: (course: Course) => void;
  sortAsc: boolean;
  setSortAsc: (v: boolean) => void;
  stickyTop?: number;
}

function getCreditColor(credits: number): string {
  if (credits <= 1) return "bg-red-50 text-red-300";
  if (credits <= 2) return "bg-red-50 text-red-400";
  if (credits <= 3) return "bg-red-100 text-red-500";
  if (credits <= 4) return "bg-red-100 text-red-600";
  if (credits <= 5) return "bg-red-200 text-red-600";
  if (credits <= 6) return "bg-red-200 text-red-700";
  if (credits <= 8) return "bg-red-300 text-red-700";
  if (credits <= 10) return "bg-red-400 text-red-800";
  return "bg-red-500 text-white";
}

export function CourseTable({ courses, selectedId, onSelect, sortAsc, setSortAsc, stickyTop = 0 }: Props) {
  const handleSort = () => setSortAsc(!sortAsc);

  if (courses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-400">
        <svg className="w-14 h-14 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-base font-medium text-gray-500">未找到匹配课程</p>
        <p className="text-sm mt-1 text-gray-400">请调整筛选条件</p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block bg-white rounded-t-2xl rounded-b-xl border border-gray-100 shadow-sm">
        <table className="w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead className="sticky" style={{ top: stickyTop, zIndex: 10 }}>
            <tr>
              <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100 rounded-tl-2xl">课程号</th>
              <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100">课程名称</th>
              <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100 cursor-pointer select-none hover:text-gray-700" onClick={handleSort}>
                学分
                <span className="ml-1 text-gray-400">{sortAsc ? "↑" : "↓"}</span>
              </th>
              <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100">开课学院</th>
              <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100">标签</th>
              <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-100 rounded-tr-2xl">教师</th>
            </tr>
          </thead>
          <tbody>
            {courses.map((c) => {
              const isSelected = c.id === selectedId;
              return (
                <tr
                  key={c.id}
                  onClick={() => onSelect(c)}
                  className={`cursor-pointer transition-colors group ${
                    isSelected
                      ? "bg-red-50/50"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <td className={`px-5 py-4 text-xs font-mono tracking-wide border-b border-gray-50 ${isSelected ? "text-gray-600" : "text-gray-400"}`}>{c.id}</td>
                  <td className={`px-5 py-4 text-[13px] font-medium border-b border-gray-50 transition-colors ${isSelected ? "text-red-600" : "text-gray-800 group-hover:text-red-600"}`}>
                    <div className="flex items-center gap-2">
                      {isSelected && <span className="w-[3px] h-4 rounded-full bg-red-500 shrink-0" />}
                      {c.name}
                    </div>
                  </td>
                  <td className="px-5 py-4 border-b border-gray-50">
                    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-bold ${getCreditColor(c.credits)}`}>
                      {c.credits}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-xs text-gray-500 max-w-[160px] truncate border-b border-gray-50">{c.dept}</td>
                  <td className="px-5 py-4 border-b border-gray-50">
                    <div className="flex flex-wrap gap-1">
                      {c.tags.slice(0, 2).map((t) => (
                        <TagBadge key={t} tag={t} />
                      ))}
                      {c.tags.length > 2 && (
                        <span className="text-[11px] text-gray-400">+{c.tags.length - 2}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-xs text-gray-500 max-w-[150px] truncate border-b border-gray-50">
                    {c.teachers.map((t) => t.name).join(", ") || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {courses.map((c) => (
          <div
            key={c.id}
            onClick={() => onSelect(c)}
            className="bg-white rounded-xl border border-gray-100 p-4 active:bg-gray-50 transition-colors cursor-pointer shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <h3 className="text-[13px] font-semibold text-gray-800 truncate">{c.name}</h3>
                <p className="text-xs text-gray-500 mt-1">{c.id} · {c.dept}</p>
              </div>
              <span className={`shrink-0 inline-flex items-center justify-center px-2 h-8 rounded-lg text-xs font-bold gap-0.5 ${getCreditColor(c.credits)}`}>
                {c.credits}<span className="font-normal opacity-70">学分</span>
              </span>
            </div>
            <div className="flex flex-wrap gap-1 mt-2.5">
              {c.tags.map((t) => (
                <TagBadge key={t} tag={t} />
              ))}
            </div>
            {c.teachers.length > 0 && (
              <p className="text-xs text-gray-500 mt-2.5 truncate">
                {c.teachers.map((t) => t.name).join(", ")}
              </p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
