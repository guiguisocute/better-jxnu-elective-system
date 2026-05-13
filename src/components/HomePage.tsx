import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useCourseData } from "../hooks/useCourseData";
import { useCourseFilter } from "../hooks/useCourseFilter";
import { useAllRatings } from "../hooks/useRatings";
import { FilterBar } from "./FilterBar";
import { CourseTable } from "./CourseTable";
import { CourseDetail } from "./CourseDetail";
import { Pagination } from "./Pagination";
import type { Course } from "../types";

export function HomePage() {
  const { courses, loading, error, allDepts, allCredits, courseTypes, subTags } = useCourseData();
  const filter = useCourseFilter(courses);
  const { getCourseAvg } = useAllRatings();
  const [selected, setSelected] = useState<Course | null>(null);
  const [ratingSortAsc, setRatingSortAsc] = useState<boolean | null>(null);
  const [showMobileFilter, setShowMobileFilter] = useState(false);
  const navigate = useNavigate();
  const headerRef = useRef<HTMLElement>(null);
  const [headerH, setHeaderH] = useState(0);

  useEffect(() => {
    const measure = () => {
      if (headerRef.current) setHeaderH(headerRef.current.offsetHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const handleSelect = (course: Course) => {
    if (window.innerWidth >= 768) {
      setSelected(course);
    } else {
      navigate(`/course/${course.id}`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA]">
        <div className="w-10 h-10 border-3 border-red-200 border-t-red-500 rounded-full animate-spin" />
        <p className="mt-4 text-gray-400 text-sm tracking-wide">正在加载课程数据...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA] px-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 max-w-md text-center">
          <h2 className="text-base font-semibold text-gray-800 mb-2">加载失败</h2>
          <p className="text-sm text-gray-400 mb-4">{error}</p>
          <p className="text-xs text-gray-300">
            请确保使用本地服务器运行：<br />
            <code className="bg-gray-50 px-2 py-1 rounded text-red-500">npm run dev</code>
          </p>
        </div>
      </div>
    );
  }

  const stickyTop = (headerH > 0 ? headerH : 120) + 20;

  return (
    <div className="min-h-screen bg-[#F8F9FA]">
      {/* Header - two layers */}
      <header ref={headerRef} className="sticky top-0 z-40">
        {/* Layer 1: Red status bar */}
        <div style={{ backgroundColor: "#CC3C3C" }}>
          <div className="max-w-[2000px] mx-auto px-6 flex items-center justify-between py-2.5">
            <div className="flex items-center gap-2.5">
              <img src="/img/JXNUlogo.png" alt="JXNU" className="w-7 h-7 rounded-lg object-contain" />
              <h1 className="text-sm font-bold tracking-tight" style={{ color: "#FFFFFF" }}>JXNU选课PLUS</h1>
              <span className="text-xs hidden sm:inline" style={{ color: "rgba(255,255,255,0.8)" }}>江西师范大学</span>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="https://github.com/guiguisocute/better-jxnu-elective-system"
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center hover:bg-white/30 transition-colors"
              >
                <svg className="w-4 h-4" style={{ color: "#FFFFFF" }} fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </a>
              <button
                onClick={() => setShowMobileFilter(!showMobileFilter)}
                className="md:hidden shrink-0 w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center hover:bg-white/30"
              >
                <svg className="w-4 h-4" style={{ color: "#FFFFFF" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Layer 2: White search bar */}
        <div className="bg-white border-b border-gray-100 shadow-sm">
          <div className="max-w-[2000px] mx-auto px-6 py-3 flex items-center gap-4">
            {/* Desktop search - centered */}
            <div className="hidden md:flex flex-1 justify-center">
              <div className="relative w-full max-w-3xl">
                <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={filter.filters.search}
                  onChange={(e) => filter.updateFilter("search", e.target.value)}
                  placeholder="搜索课程名称、学院、教师..."
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 placeholder-gray-300 text-sm outline-none focus:bg-white focus:border-red-300 focus:ring-2 focus:ring-red-50 transition-all"
                />
              </div>
            </div>

            {/* Result count */}
            <div className="shrink-0 text-sm text-gray-400 whitespace-nowrap">
              <span className="font-semibold text-gray-700">{filter.filtered.length}</span>
              <span> / {courses.length} 门</span>
            </div>

            {/* Mobile search */}
            <div className="md:hidden flex-1 min-w-0">
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={filter.filters.search}
                  onChange={(e) => filter.updateFilter("search", e.target.value)}
                  placeholder="搜索课程、教师..."
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 placeholder-gray-300 text-sm outline-none focus:bg-white focus:border-red-300 transition-all"
                />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile filter drawer */}
      {showMobileFilter && (
        <div className="md:hidden fixed inset-0 z-50" onClick={() => setShowMobileFilter(false)}>
          <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" />
          <div
            className="absolute right-0 top-0 bottom-0 w-80 max-w-[85vw] bg-white overflow-y-auto shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-800">筛选条件</h2>
              <button onClick={() => setShowMobileFilter(false)} className="p-1 text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-5">
              <FilterBar
                filters={filter.filters}
                updateFilter={filter.updateFilter}
                cycleCredit={filter.cycleCredit}
                cycleDept={filter.cycleDept}
                cycleType={filter.cycleType}
                cycleTag={filter.cycleTag}
                clearAll={filter.clearAll}
                hasActiveFilters={filter.hasActiveFilters}
                allDepts={allDepts}
                allCredits={allCredits}
                courseTypes={courseTypes}
                subTags={subTags}
              />
            </div>
          </div>
        </div>
      )}

      {/* Main layout */}
      <div className="max-w-[2000px] mx-auto flex px-3 md:px-6 pt-5 gap-5">
        {/* Desktop left sidebar */}
        <aside
          className="hidden md:block w-[300px] shrink-0 overflow-y-auto rounded-t-2xl bg-white border border-gray-100 px-6 py-5 shadow-sm"
          style={{ position: "sticky", top: stickyTop, height: `calc(100vh - ${stickyTop}px)` }}
        >
          <FilterBar
            filters={filter.filters}
            updateFilter={filter.updateFilter}
            cycleCredit={filter.cycleCredit}
            cycleDept={filter.cycleDept}
            cycleType={filter.cycleType}
            cycleTag={filter.cycleTag}
            clearAll={filter.clearAll}
            hasActiveFilters={filter.hasActiveFilters}
            allDepts={allDepts}
            allCredits={allCredits}
            courseTypes={courseTypes}
            subTags={subTags}
          />
        </aside>

        {/* Center - course list */}
        <main className="flex-1 min-w-0">
          <CourseTable
            courses={filter.paginated}
            selectedId={selected?.id}
            onSelect={handleSelect}
            sortAsc={filter.sortAsc}
            setSortAsc={filter.setSortAsc}
            ratingSortAsc={ratingSortAsc}
            setRatingSortAsc={setRatingSortAsc}
            stickyTop={stickyTop}
            getCourseAvg={getCourseAvg}
          />
          <Pagination
            page={filter.page}
            totalPages={filter.totalPages}
            onPageChange={filter.setPage}
          />
        </main>

        {/* Desktop right sidebar - always visible */}
        <aside
          className="hidden md:block w-[420px] shrink-0 overflow-y-auto rounded-t-2xl bg-white border border-gray-100 shadow-[-8px_0_24px_rgba(0,0,0,0.04)]"
          style={{ position: "sticky", top: stickyTop, height: `calc(100vh - ${stickyTop}px)` }}
        >
          {selected ? (
            <CourseDetail course={selected} onClose={() => setSelected(null)} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 px-8">
              <svg className="w-12 h-12 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
              </svg>
              <p className="text-sm font-medium text-gray-500">点击课程查看详情</p>
              <p className="text-xs text-gray-400 mt-1">从左侧列表中选择一门课程</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
