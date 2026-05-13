import { useParams, useNavigate } from "react-router-dom";
import { useCourseData } from "../hooks/useCourseData";
import { TagBadge } from "./TagBadge";

export function CourseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { courses, loading, error } = useCourseData();

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA]">
        <div className="w-10 h-10 border-3 border-red-200 border-t-red-500 rounded-full animate-spin" />
        <p className="mt-4 text-gray-500 text-sm">正在加载...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA]">
        <p className="text-red-500">{error}</p>
        <button onClick={() => navigate("/")} className="mt-4 text-sm text-red-500 hover:text-red-600">返回首页</button>
      </div>
    );
  }

  const course = courses.find((c) => c.id === id);

  if (!course) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA]">
        <p className="text-gray-500">未找到该课程</p>
        <button onClick={() => navigate("/")} className="mt-4 text-sm text-red-500 hover:text-red-600">返回首页</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA]">
      {/* Header - two layers */}
      <header className="sticky top-0 z-40">
        <div style={{ backgroundColor: "#CC3C3C" }}>
          <div className="max-w-3xl mx-auto px-5 flex items-center gap-2.5 py-2.5">
            <button
              onClick={() => navigate("/")}
              className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center hover:bg-white/30 transition-colors"
            >
              <svg className="w-4 h-4" style={{ color: "#FFFFFF" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <img src="/img/JXNUlogo.png" alt="JXNU" className="w-6 h-6 rounded-md object-contain" />
            <h1 className="text-sm font-bold tracking-tight truncate" style={{ color: "#FFFFFF" }}>JXNU选课PLUS</h1>
          </div>
        </div>

        <div className="bg-white border-b border-gray-100 shadow-sm">
          <div className="max-w-3xl mx-auto px-5 py-3">
            <h2 className="text-base font-semibold text-gray-900 truncate">{course.name}</h2>
            <p className="text-xs text-gray-500 font-mono mt-0.5">{course.id}</p>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-5 py-6 space-y-5">
        {/* Tags and credits */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-4">
            <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-red-50 text-red-500 text-xs font-semibold">
              {course.credits} 学分
            </span>
            <div className="flex flex-wrap gap-1.5">
              {course.tags.map((tag) => (
                <TagBadge key={tag} tag={tag} />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <InfoItem label="开课学院" value={course.dept} />
            <InfoItem label="开课学期" value={course.semester || "未指定"} />
            {course.prereqDesc && (
              <InfoItem label="先修课程" value={course.prereqDesc} span2 />
            )}
          </div>
        </div>

        {/* Description */}
        {course.desc && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">课程简介</h3>
            <p className="text-[13px] text-gray-700 whitespace-pre-line" style={{ lineHeight: 1.8 }}>
              {course.desc}
            </p>
          </div>
        )}

        {/* Teachers */}
        {course.teachers.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
              任课教师 ({course.teachers.length})
            </h3>
            <div className="space-y-2">
              {course.teachers.map((t, i) => (
                <div key={i} className="flex items-center gap-3.5 bg-gray-50 rounded-xl px-4 py-3">
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
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="text-center text-gray-400 py-10 text-sm">暂无教师信息</div>
          </div>
        )}

        <a
          href={`https://xk.jxnu.edu.cn/Step1/AddCourse.aspx?kch=${course.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full py-3 rounded-xl bg-red-500 text-white text-sm font-medium text-center hover:bg-red-600 active:bg-red-700 transition-colors shadow-sm"
        >
          点击跳转选课界面
        </a>
      </main>
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
