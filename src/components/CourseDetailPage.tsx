import { useParams, useNavigate } from "react-router-dom";
import { useCourseData } from "../hooks/useCourseData";
import { CourseDetail } from "./CourseDetail";

/**
 * 独立路由 /course/:id 的承载页（手机端刷新/直链入口）。
 * 不再维护自己的详情 UI —— 全部委托给 CourseDetail 组件，确保
 * 培养方案归属、学位课徽章等新 UI 一处维护处处生效。
 */
export function CourseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { courses, loading, error } = useCourseData();

  const course = courses.find((c) => c.id === id);

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
        <button onClick={() => navigate("/")} className="mt-4 text-sm text-red-500 hover:text-red-600">
          返回首页
        </button>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA]">
        <p className="text-gray-500">未找到该课程</p>
        <button onClick={() => navigate("/")} className="mt-4 text-sm text-red-500 hover:text-red-600">
          返回首页
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA] flex flex-col">
      {/* 顶部红色品牌条 + 返回按钮 */}
      <header className="sticky top-0 z-40" style={{ backgroundColor: "#CC3C3C" }}>
        <div className="max-w-3xl mx-auto px-5 flex items-center gap-2.5 py-2.5">
          <button
            onClick={() => navigate("/")}
            className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center hover:bg-white/30 transition-colors"
            aria-label="返回"
          >
            <svg className="w-4 h-4" style={{ color: "#FFFFFF" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <img src="/img/JXNUlogo.png" alt="JXNU" className="w-6 h-6 rounded-md object-contain" />
          <h1 className="text-sm font-bold tracking-tight truncate" style={{ color: "#FFFFFF" }}>
            JXNU选课PLUS
          </h1>
        </div>
      </header>

      {/* 详情卡片 —— 完全委托给 CourseDetail */}
      <main className="flex-1 max-w-3xl w-full mx-auto bg-white">
        <CourseDetail course={course} onClose={() => navigate("/")} />
      </main>
    </div>
  );
}
