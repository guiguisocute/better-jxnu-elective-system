import type { Course } from "../types";
import { TagBadge } from "./TagBadge";

interface Props {
  course: Course;
  onClose: () => void;
}

export function CourseDetail({ course, onClose }: Props) {
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="relative px-6 py-5 border-b border-gray-100 shrink-0">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <h2 className="text-base font-semibold text-gray-900 pr-8 leading-snug">{course.name}</h2>
        <div className="flex items-center gap-2.5 mt-2.5">
          <span className="text-xs text-gray-500 font-mono">{course.id}</span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-red-50 text-red-500 text-xs font-semibold">
            {course.credits} 学分
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5 space-y-6">
          {/* Tags */}
          {course.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {course.tags.map((tag) => (
                <TagBadge key={tag} tag={tag} />
              ))}
            </div>
          )}

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <InfoItem label="开课学院" value={course.dept} />
            <InfoItem label="开课学期" value={course.semester || "未指定"} />
            {course.prereqDesc && (
              <InfoItem label="先修课程" value={course.prereqDesc} span2 />
            )}
          </div>

          {/* Description */}
          {course.desc && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">课程简介</h3>
              <p className="text-[13px] text-gray-700 whitespace-pre-line bg-gray-50 rounded-xl px-5 py-4" style={{ lineHeight: 1.8 }}>
                {course.desc}
              </p>
            </div>
          )}

          {/* Teachers */}
          {course.teachers.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                任课教师 ({course.teachers.length})
              </h3>
              <div className="space-y-2">
                {course.teachers.map((t, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3.5 bg-gray-50 rounded-xl px-4 py-3"
                  >
                    <div className="w-9 h-9 rounded-full bg-red-50 text-red-400 flex items-center justify-center text-sm font-semibold shrink-0">
                      {t.name[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-gray-800">
                        {t.name}
                        <span className="text-gray-400 font-normal ml-1.5 text-xs">{t.gender}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        教号 {t.id} · {t.dept}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {course.teachers.length === 0 && (
            <div className="text-center text-gray-400 py-10 text-sm">
              暂无教师信息
            </div>
          )}

          <a
            href={`https://xk.jxnu.edu.cn/Step1/AddCourse.aspx?kch=${course.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-2.5 rounded-xl bg-red-500 text-white text-sm font-medium text-center hover:bg-red-600 active:bg-red-700 transition-colors"
          >
            点击跳转选课界面
          </a>
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value, span2 }: { label: string; value: string; span2?: boolean }) {
  return (
    <div className={span2 ? "col-span-2" : ""}>
      <div className="text-[11px] text-gray-500 mb-1 uppercase tracking-wider">{label}</div>
      <div className="text-[13px] text-gray-700 leading-relaxed">{value}</div>
    </div>
  );
}
