import type { Course, DataSource, FormalSection } from "../types";
import { TagBadge } from "./TagBadge";
import { StarRating } from "./StarRating";
import { CopyIdButton } from "./CopyIdButton";
import { displayTags, isInPlan, compactTags } from "../lib/planMatch";
import { DataSourceSwitcher } from "./DataSourceSwitcher";
import { SemesterSelector } from "./SemesterSelector";
import { isTestSemester } from "../lib/term";
import { normalizePeriods, unselectedIncludeSlots, slotLabel } from "../lib/scheduleParse";
import type { ScheduleFilterMap } from "../lib/scheduleParse";

interface Props {
  courses: Course[];
  selectedId?: string;
  onSelect: (course: Course) => void;
  sortAsc: boolean;
  setSortAsc: (v: boolean) => void;
  ratingSortAsc: boolean | null;
  setRatingSortAsc: (v: boolean | null) => void;
  stickyTop?: number;
  getCourseAvg?: (courseId: string) => number | null;
  /** 正选/补退选行用：按 (课程, 老师) 取该 section 教师的评分；预选行仍用 getCourseAvg（课程平均）。 */
  getTeacherAvg?: (courseId: string, teacherId: string) => { avg: number; count: number } | null;
  /** 选中的培养方案 key。空串表示未选 —— 此时不做高亮也不裁剪 tag。 */
  selectedPlan?: string;
  /** 数据源（预选 / 正选 / 补退选）。 */
  dataSource: DataSource;
  onChangeDataSource: (v: DataSource) => void;
  /** 正选/补退选 sections（已按 semester 过滤）。 */
  formalSections?: FormalSection[];
  formalAvailable?: boolean;
  formalLoading?: boolean;
  /** 学期下拉选项（来自 useFormalData.allSemesters）+ 当前选中值。 */
  allSemesters?: string[];
  selectedSemester?: string;
  onChangeSemester?: (v: string) => void;
  /** 正选/补退选行点击 —— 由 HomePage 决定走 CourseDetail 还是 fallback。 */
  onSelectSection?: (s: FormalSection) => void;
  /** 当前选中行的 key，格式：`${id}|${className}|${teacherId}`。 */
  selectedSectionKey?: string | null;
  /** 模拟选课模式：预选行尾出现加车按钮、名称旁出现「已加入」徽章。 */
  simMode?: boolean;
  cartHas?: (id: string) => boolean;
  onToggleCart?: (id: string) => void;
  /** 课表时段筛选状态，用于多时段冲突警告（include 命中但还占用未选时段）。 */
  scheduleFilter?: ScheduleFilterMap;
  /** 课程号 → Course 映射。正选/补退选行据此回查 plans，做培养方案归属高亮。 */
  coursesById?: Map<string, Course>;
}

// 多时段冲突悬停文案：该 section 因某时段命中 include 入选，但还占用了未选时段。
function conflictTitle(slots: { day: number; slot: string }[]): string {
  return `时间冲突：这门课还占用你未选的时段 ${slots.map(slotLabel).join("、")}`;
}

// 多时段冲突标记：在「上课时间」处显示一个加粗红色三角感叹号，
// 占位极小，具体冲突时段只在鼠标悬停（title）时展开。
function ConflictMark({ slots }: { slots: { day: number; slot: string }[] }) {
  if (slots.length === 0) return null;
  return (
    <span title={conflictTitle(slots)} aria-label="时间冲突" className="shrink-0 inline-flex text-rose-600">
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
        <path fillRule="evenodd" clipRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z" />
      </svg>
    </span>
  );
}

// 手机端正选/补退选卡片的信息行：矢量图标 + 文字说明标签 + 值。
// tone="alert" 用于时段冲突的「上课时间」行（红底 + 红字）；trailing 放冲突标记（不被截断）。
function InfoRow({
  icon, label, children, tone = "default", title, trailing,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  tone?: "default" | "alert";
  title?: string;
  trailing?: React.ReactNode;
}) {
  const alert = tone === "alert";
  return (
    <div
      title={title}
      className={`flex items-center gap-1.5 ${alert ? "-mx-1 px-1 py-0.5 rounded bg-rose-50 text-rose-700 font-medium" : ""}`}
    >
      <span className={`shrink-0 ${alert ? "text-rose-500" : "text-gray-400"}`}>{icon}</span>
      <span className={`shrink-0 w-7 ${alert ? "text-rose-500" : "text-gray-400"}`}>{label}</span>
      <span className={`min-w-0 truncate ${alert ? "" : "text-gray-600"}`}>{children}</span>
      {trailing}
    </div>
  );
}

function TeacherIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
function ClassIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 11a3 3 0 100-6 3 3 0 000 6zM2.5 20a6.5 6.5 0 0113 0M16 5.5a3 3 0 010 5.5M21.5 20a6.5 6.5 0 00-4.5-6.18" />
    </svg>
  );
}
function RoomIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21s-6-5.686-6-10a6 6 0 1112 0c0 4.314-6 10-6 10z" />
      <circle cx="12" cy="11" r="2" />
    </svg>
  );
}

// 预选行尾的「加入待选清单 / 已加入」按钮（仅模拟选课模式）。
function CartButton({ inCart, onToggle }: { inCart: boolean; onToggle: () => void }) {
  const handle = (e: { stopPropagation: () => void }) => { e.stopPropagation(); onToggle(); };
  if (inCart) {
    return (
      <button
        onClick={handle}
        title="从待选清单移除"
        className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-red-50 text-red-500 hover:bg-red-100"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </button>
    );
  }
  return (
    <button
      onClick={handle}
      title="加入待选清单"
      className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center w-7 h-7 rounded-lg border border-red-200 text-red-500 hover:bg-red-50"
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path strokeLinecap="round" d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );
}

// 上课时间紧凑化：「星期三-第12节 / 星期二-第十节」→「周三-1,2/周二-10」
function compressSchedule(raw: string): string {
  if (!raw) return "—";
  return raw
    .split(" / ")
    .map((seg) => {
      const m = seg.match(/^星期(.)-第([\d一二三四五六七八九十]+)节$/);
      if (!m) return seg;
      const periods = normalizePeriods(m[2]);
      return `周${m[1]}-${periods}`;
    })
    .join("/");
}

// 班级名称紧凑化：超长时取「前3字……末4字」中略式，避免列内截断把关键的「x级 / x班」吃掉。
function compressClassName(raw: string, maxLen = 11): string {
  if (!raw) return "—";
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, 3) + "……" + raw.slice(-4);
}

function getCreditColor(credits: number): string {
  // 亮色：浅红底 + 深红字，色阶随学分递增饱和度。
  // 暗色：用 arbitrary value 走深红 brick(#7F1D1D)/暗砖(#991B1B)/red-700(#B91C1C)/brand(#A33) 半透明，配近白色文字。
  // 注意：亮色的 bg-red-*/text-red-* 被 index.css 全局 .dark 补丁映射覆盖，会压过 dark: 变体 ——
  //       故凡被映射的档位都改用 arbitrary hex 绕过，dark: 才能干净生效（未被映射的 text-red-300/400 保留类名）。
  if (credits <= 1) return "bg-[#FEF2F2] text-red-300 dark:bg-[#7F1D1D]/30 dark:text-[#FCA5A5]";
  if (credits <= 2) return "bg-[#FEF2F2] text-red-400 dark:bg-[#7F1D1D]/40 dark:text-[#FCA5A5]";
  if (credits <= 3) return "bg-[#FEE2E2] text-[#EF4444] dark:bg-[#7F1D1D]/55 dark:text-[#FECACA]";
  if (credits <= 4) return "bg-[#FEE2E2] text-[#DC2626] dark:bg-[#7F1D1D]/70 dark:text-[#FECACA]";
  if (credits <= 5) return "bg-[#FECACA] text-[#DC2626] dark:bg-[#991B1B]/70 dark:text-[#FEE2E2]";
  if (credits <= 6) return "bg-[#FECACA] text-[#B91C1C] dark:bg-[#991B1B]/85 dark:text-[#FEE2E2]";
  if (credits <= 8) return "bg-[#FCA5A5] text-[#B91C1C] dark:bg-[#B91C1C]/90 dark:text-white";
  if (credits <= 10) return "bg-[#F87171] text-[#991B1B] dark:bg-[#B91C1C] dark:text-white";
  return "bg-[#EF4444] text-white dark:bg-[#A33] dark:text-white";
}

const FORMAL_HEADERS = [
  "课程号", "课程名称", "学分", "开课学院", "标签",
  "任课教师", "上课时间", "班级名称", "教室代号", "容量", "评分",
];

const DESKTOP_TOOLBAR_HEIGHT = 50;

export function CourseTable({
  courses, selectedId, onSelect, sortAsc, setSortAsc, ratingSortAsc, setRatingSortAsc,
  stickyTop = 0, getCourseAvg, getTeacherAvg, selectedPlan = "",
  dataSource, onChangeDataSource,
  formalSections = [], formalAvailable = false, formalLoading = false,
  allSemesters = [], selectedSemester = "", onChangeSemester,
  onSelectSection,
  selectedSectionKey = null,
  simMode = false, cartHas, onToggleCart, scheduleFilter, coursesById,
}: Props) {
  const handleSort = () => {
    setRatingSortAsc(null);
    setSortAsc(!sortAsc);
  };

  const handleRatingSort = () => {
    if (ratingSortAsc === null) {
      setRatingSortAsc(false);
    } else {
      setRatingSortAsc(!ratingSortAsc);
    }
  };

  // 正选 + 补退选 共用 formal 列布局与数据源（暂用同一份 JSON）
  const isFormal = dataSource === "formal" || dataSource === "addDrop";
  const tableHeaderTop = stickyTop + DESKTOP_TOOLBAR_HEIGHT;

  return (
    <div>
      {/* ===== 桌面端 ===== */}
      {/* 不要给 wrapper 加 border-top —— 那条 1px gray-100 是表里"工具栏与搜索框间 1px 缝隙"
          的真正元凶：sticky toolbar 不能贴住 wrapper border 的 1px 偏移，露出灰线即缝。 */}
      {/* 全圆角 wrapper —— 跟左右两侧卡片对齐。早先用 overflow-x-clip / clipPath 是为了
          裁掉评分列星星溢出圆角边，但 table-fixed + colgroup 已经把列宽锁死，星星稳稳在
          cell 内，不再需要裁剪；保留 clip-path 反而会把外层 shadow-sm 也一起裁掉。 */}
      <div className="hidden md:block bg-white rounded-xl border border-gray-100 shadow-sm">
        {/* Toolbar —— 左：数据源切换；右：学期下拉。 */}
        <div
          className="sticky z-30 flex h-[50px] items-center justify-between bg-white px-5 border-b border-gray-100 relative"
          style={{ top: stickyTop }}
        >
          <DataSourceSwitcher value={dataSource} onChange={onChangeDataSource} />
          {isFormal && selectedSemester && isTestSemester(selectedSemester) && (
            <div
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-[12px] font-medium text-amber-700 ring-1 ring-amber-200 max-w-[60%]"
              role="status"
            >
              <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" clipRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z" />
              </svg>
              <span className="truncate">此表数据仅供功能测试，{selectedSemester}开课安排暂未发布，请注意</span>
            </div>
          )}
          {onChangeSemester && (
            <SemesterSelector
              value={selectedSemester}
              onChange={onChangeSemester}
              options={allSemesters}
              isFormalView={isFormal}
            />
          )}
        </div>

        {isFormal ? (
          /* 正选 / 补退选视图 —— 不用 overflow-x-auto 包，避免破坏 sticky thead 的定位上下文。
             表格让其自然占满 main 宽度（main 已是 min-w-0 弹性宽度）。 */
          <table className="w-full table-fixed" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
              {/* 列宽（顺序）：课程号8 / 课程名称14 / 学分5 / 开课学院10 / 标签14 /
                 任课教师8 / 上课时间10 / 班级名称12 / 教室代号7 / 容量5 / 评分7 (%)。
                 注意：<colgroup> 只能含 <col>，行内注释会产生空白文本节点告警，勿加。 */}
              <colgroup>
                <col style={{ width: "8%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "5%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "5%" }} />
                <col style={{ width: "7%" }} />
              </colgroup>
              <thead className="sticky" style={{ top: tableHeaderTop, zIndex: 10 }}>
                <tr>
                  {FORMAL_HEADERS.map((h) => {
                    // 学分 / 评分 列与预选共用排序状态，点击切升降序
                    if (h === "学分") {
                      return (
                        <th
                          key={h}
                          onClick={handleSort}
                          className="px-3 py-3.5 text-left bg-gray-50 border-b border-gray-100 cursor-pointer select-none group/sort"
                        >
                          <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium uppercase tracking-wider transition-colors ${
                            ratingSortAsc === null ? "text-red-600" : "text-gray-500 group-hover/sort:text-gray-700"
                          }`}>
                            学分
                            <span className={ratingSortAsc === null ? "text-red-500" : "text-gray-400"}>{sortAsc ? "↑" : "↓"}</span>
                          </span>
                          <span className={`mt-1 block h-0.5 w-5 rounded-full transition-colors ${ratingSortAsc === null ? "bg-red-400" : "bg-transparent"}`} />
                        </th>
                      );
                    }
                    if (h === "评分") {
                      return (
                        <th
                          key={h}
                          onClick={handleRatingSort}
                          className="px-3 py-3.5 text-left bg-gray-50 border-b border-gray-100 cursor-pointer select-none group/sort"
                        >
                          <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium uppercase tracking-wider transition-colors ${
                            ratingSortAsc !== null ? "text-red-600" : "text-gray-500 group-hover/sort:text-gray-700"
                          }`}>
                            评分
                            <span className={ratingSortAsc !== null ? "text-red-500" : "text-gray-400"}>{ratingSortAsc === null ? "↕" : ratingSortAsc ? "↑" : "↓"}</span>
                          </span>
                          <span className={`mt-1 block h-0.5 w-5 rounded-full transition-colors ${ratingSortAsc !== null ? "bg-red-400" : "bg-transparent"}`} />
                        </th>
                      );
                    }
                    return (
                      <th
                        key={h}
                        className="px-3 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap bg-gray-50 border-b border-gray-100"
                      >
                        {h}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {formalLoading ? (
                  <tr>
                    <td colSpan={FORMAL_HEADERS.length} className="py-24">
                      <div className="flex flex-col items-center justify-center text-gray-400">
                        <div className="w-8 h-8 border-3 border-red-200 border-t-red-500 rounded-full animate-spin" />
                        <p className="mt-3 text-sm text-gray-400">加载中...</p>
                      </div>
                    </td>
                  </tr>
                ) : !formalAvailable ? (
                  <tr>
                    <td colSpan={FORMAL_HEADERS.length} className="py-24">
                      <div className="flex flex-col items-center justify-center text-gray-400 px-6 text-center">
                        <svg className="w-14 h-14 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <p className="text-base font-medium text-gray-500">
                          {dataSource === "addDrop" ? "补退选阶段尚未开始" : "正选阶段尚未开始"}
                        </p>
                        <p className="text-sm mt-1 text-gray-400">教务系统发布数据后此处将自动显示实际开班课程</p>
                      </div>
                    </td>
                  </tr>
                ) : formalSections.length === 0 ? (
                  <tr>
                    <td colSpan={FORMAL_HEADERS.length} className="py-24">
                      <div className="flex flex-col items-center justify-center text-gray-400">
                        <p className="text-base font-medium text-gray-500">未找到匹配课程</p>
                        <p className="text-sm mt-1 text-gray-400">请调整筛选条件或切换学期</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  formalSections.map((s, idx) => {
                    const sKey = `${s.id}|${s.className}|${s.teacherId}`;
                    const isSelected = sKey === selectedSectionKey;
                    const warnSlots = scheduleFilter ? unselectedIncludeSlots(s, scheduleFilter) : [];
                    const sCourse = selectedPlan ? coursesById?.get(s.id) : undefined;
                    const inPlan = !!sCourse && isInPlan(sCourse, selectedPlan);
                    return (
                    <tr
                      key={`${s.id}-${s.className}-${s.teacherId}-${idx}`}
                      onClick={() => onSelectSection?.(s)}
                      className={`group transition-colors cursor-pointer ${isSelected ? "bg-red-50/50" : inPlan ? "bg-indigo-50/40 hover:bg-indigo-50/60" : "hover:bg-gray-50"}`}
                    >
                      <td className={`px-3 py-3 text-xs font-mono tracking-wide border-b border-gray-50 whitespace-nowrap ${isSelected ? "text-gray-600" : "text-gray-400"} ${inPlan && !isSelected ? "border-l-2 border-l-indigo-400" : ""}`}>
                        <span className="inline-flex items-center gap-1">
                          {s.id}
                          <CopyIdButton text={s.id} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                        </span>
                      </td>
                      <td className={`px-3 py-3 text-[13px] font-medium border-b border-gray-50 ${isSelected ? "text-red-600" : "text-gray-800"}`}>
                        <span className="flex items-center gap-2 min-w-0">
                          {isSelected && <span className="w-[3px] h-4 rounded-full bg-red-500 shrink-0" />}
                          {!isSelected && inPlan && <span className="w-[3px] h-4 rounded-full bg-indigo-400 shrink-0" />}
                          <span className="block truncate" title={s.name}>{s.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-3 border-b border-gray-50">
                        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-bold ${getCreditColor(s.credits)}`}>
                          {s.credits || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-500 border-b border-gray-50">
                        <span className="block truncate" title={s.dept}>{s.dept || "—"}</span>
                      </td>
                      {/* 标签格：内层 min-w-0 overflow-hidden 确保 badge 不会越界吃到下一格。
                         compactTags：当存在「公选课-XXX」子类时省掉冗余的「公选课」父 tag。
                         选了培养方案 → 走 displayTags（裁剪非本方案 nature + 注入「任意选修」），与预选一致。 */}
                      {(() => {
                        const tags = sCourse
                          ? compactTags(displayTags(sCourse, selectedPlan))
                          : compactTags(s.tags);
                        return (
                          <td className="px-3 py-3 border-b border-gray-50 align-top">
                            <div className="flex flex-col gap-1 items-start min-w-0 overflow-hidden">
                              {tags.slice(0, 2).map((t) => (
                                <span key={t} className="max-w-full truncate" title={t}>
                                  <TagBadge tag={t} />
                                </span>
                              ))}
                              {tags.length > 2 && (
                                <span className="text-[11px] text-gray-400">+{tags.length - 2}</span>
                              )}
                            </div>
                          </td>
                        );
                      })()}
                      <td className="px-3 py-3 text-xs text-gray-600 border-b border-gray-50 whitespace-nowrap">
                        <span className="block truncate" title={s.teacher}>{s.teacher || "—"}</span>
                      </td>
                      <td className={`px-3 py-3 text-xs border-b border-gray-50 ${warnSlots.length > 0 ? "bg-rose-50" : ""}`}>
                        <span
                          className={`flex items-center gap-1 min-w-0 ${warnSlots.length > 0 ? "text-rose-700 font-medium" : "text-gray-600"}`}
                          title={warnSlots.length > 0 ? conflictTitle(warnSlots) : s.schedule}
                        >
                          <span className="truncate">{compressSchedule(s.schedule)}</span>
                          <ConflictMark slots={warnSlots} />
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600 border-b border-gray-50">
                        <span className="block truncate" title={s.className}>{compressClassName(s.className)}</span>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-500 font-mono border-b border-gray-50 whitespace-nowrap">
                        <span className="block truncate" title={s.classroom}>{s.classroom || "—"}</span>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-500 border-b border-gray-50 whitespace-nowrap">{s.capacity ?? "—"}</td>
                      {/* 评分：正选/补退选 按 (课程, 该 section 老师) 取分；该老师无人评 → "—"。
                          预选行（下面）仍用 getCourseAvg（课程跨教师平均）。 */}
                      <td className="px-3 py-3 border-b border-gray-50 whitespace-nowrap">
                        {(() => {
                          const t = getTeacherAvg?.(s.id, s.teacherId);
                          const avg = t?.avg ?? null;
                          if (avg === null || avg === undefined) {
                            return <span className="text-xs text-gray-300">—</span>;
                          }
                          return (
                            <span className="inline-flex items-baseline gap-0.5 tabular-nums">
                              <span className="text-amber-500 text-[11px]">★</span>
                              <span className="text-[13px] font-semibold text-gray-700">{avg.toFixed(1)}</span>
                            </span>
                          );
                        })()}
                      </td>
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
        ) : courses.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <svg className="w-14 h-14 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-base font-medium text-gray-500">未找到匹配课程</p>
            <p className="text-sm mt-1 text-gray-400">请调整筛选条件</p>
          </div>
        ) : (
          <table className="w-full table-fixed" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            {/* 列宽：课程号 / 课程名称 / 学分 / 开课学院 / 标签 / 教师 / 评分 (+ 模拟选课加车列)。
               固定布局避免长课名（如"教育实践 (含专题见习、教育实习、实践研习)"）把右侧顶出。 */}
            <colgroup>
              <col style={{ width: simMode ? "9%"  : "10%" }} />
              <col style={{ width: simMode ? "24%" : "26%" }} />
              <col style={{ width: simMode ? "6%"  : "7%"  }} />
              <col style={{ width: simMode ? "15%" : "16%" }} />
              <col style={{ width: simMode ? "14%" : "15%" }} />
              <col style={{ width: simMode ? "12%" : "12%" }} />
              <col style={{ width: simMode ? "14%" : "14%" }} />
              {simMode && <col style={{ width: "6%" }} />}
            </colgroup>
            <thead className="sticky" style={{ top: tableHeaderTop, zIndex: 10 }}>
              <tr>
                <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap bg-gray-50 border-b border-gray-100">课程号</th>
                <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap bg-gray-50 border-b border-gray-100">课程名称</th>
                <th className="px-5 py-3.5 text-left bg-gray-50 border-b border-gray-100 cursor-pointer select-none group/sort" onClick={handleSort}>
                  <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium uppercase tracking-wider transition-colors ${
                    ratingSortAsc === null ? "text-red-600" : "text-gray-500 group-hover/sort:text-gray-700"
                  }`}>
                    学分
                    <span className={ratingSortAsc === null ? "text-red-500" : "text-gray-400"}>{sortAsc ? "↑" : "↓"}</span>
                  </span>
                  <span className={`mt-1 block h-0.5 w-5 rounded-full transition-colors ${ratingSortAsc === null ? "bg-red-400" : "bg-transparent"}`} />
                </th>
                <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap bg-gray-50 border-b border-gray-100">开课学院</th>
                <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap bg-gray-50 border-b border-gray-100">标签</th>
                <th className="px-5 py-3.5 text-left text-[11px] font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap bg-gray-50 border-b border-gray-100">教师</th>
                <th className="pl-3 pr-5 py-3.5 text-left bg-gray-50 border-b border-gray-100 cursor-pointer select-none group/sort" onClick={handleRatingSort}>
                  <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium uppercase tracking-wider transition-colors ${
                    ratingSortAsc !== null ? "text-red-600" : "text-gray-500 group-hover/sort:text-gray-700"
                  }`}>
                    评分
                    <span className={ratingSortAsc !== null ? "text-red-500" : "text-gray-400"}>{ratingSortAsc === null ? "↕" : ratingSortAsc ? "↑" : "↓"}</span>
                  </span>
                  <span className={`mt-1 block h-0.5 w-5 rounded-full transition-colors ${ratingSortAsc !== null ? "bg-red-400" : "bg-transparent"}`} />
                </th>
                {simMode && <th className="w-12 bg-gray-50 border-b border-gray-100" aria-label="加入待选清单" />}
              </tr>
            </thead>
            <tbody>
              {courses.map((c) => {
                const isSelected = c.id === selectedId;
                const inPlan = isInPlan(c, selectedPlan);
                const tags = compactTags(displayTags(c, selectedPlan));
                return (
                  <tr
                    key={c.id}
                    onClick={() => onSelect(c)}
                    className={`cursor-pointer transition-colors group ${
                      isSelected
                        ? "bg-red-50/50"
                        : inPlan
                        ? "bg-indigo-50/40 hover:bg-indigo-50/60"
                        : "hover:bg-gray-50"
                    }`}
                  >
                    <td className={`px-5 py-4 text-xs font-mono tracking-wide border-b border-gray-50 ${isSelected ? "text-gray-600" : "text-gray-400"} ${inPlan && !isSelected ? "border-l-2 border-l-indigo-400" : ""}`}>
                      <span className="inline-flex items-center gap-1">
                        {c.id}
                        <CopyIdButton text={c.id} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                      </span>
                    </td>
                    <td className={`px-5 py-4 text-[13px] font-medium border-b border-gray-50 transition-colors ${isSelected ? "text-red-600" : "text-gray-800 group-hover:text-red-600"}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        {isSelected && <span className="w-[3px] h-4 rounded-full bg-red-500 shrink-0" />}
                        {!isSelected && inPlan && <span className="w-[3px] h-4 rounded-full bg-indigo-400 shrink-0" />}
                        <span className="truncate flex-1 min-w-0" title={c.name}>{c.name}</span>
                        {simMode && cartHas?.(c.id) && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-red-50 border border-red-200 text-red-600 text-[10px] font-semibold shrink-0">
                            <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                            已加入
                          </span>
                        )}
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
                        {tags.slice(0, 2).map((t) => (
                          <TagBadge key={t} tag={t} />
                        ))}
                        {tags.length > 2 && (
                          <span className="text-[11px] text-gray-400">+{tags.length - 2}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-xs text-gray-500 max-w-[150px] truncate border-b border-gray-50">
                      {c.teachers.map((t) => t.name).join(", ") || "—"}
                    </td>
                    <td className="pl-3 pr-5 py-4 border-b border-gray-50">
                      <StarRating rating={getCourseAvg?.(c.id) ?? null} />
                    </td>
                    {simMode && (
                      <td className="px-3 py-4 border-b border-gray-50 text-right">
                        <CartButton
                          inCart={!!cartHas?.(c.id)}
                          onToggle={() => onToggleCart?.(c.id)}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ===== 移动端 ===== */}
      <div className="md:hidden">
        {/* Mobile toolbar: 数据源切换 */}
        <div className="flex items-center justify-between px-1 pt-1 pb-2.5 bg-page">
          <DataSourceSwitcher value={dataSource} onChange={onChangeDataSource} />
        </div>

        {/* Mobile semester selector */}
        {onChangeSemester && (
          <div className="flex items-center justify-end mb-2 px-1">
            <SemesterSelector value={selectedSemester} onChange={onChangeSemester} options={allSemesters} isFormalView={isFormal} />
          </div>
        )}

        {isFormal ? (
          formalLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <div className="w-8 h-8 border-3 border-red-200 border-t-red-500 rounded-full animate-spin" />
              <p className="mt-3 text-sm text-gray-400">加载中...</p>
            </div>
          ) : !formalAvailable ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400 px-6 text-center bg-white rounded-xl border border-gray-100 shadow-sm">
              <svg className="w-12 h-12 mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-sm font-medium text-gray-500">
                {dataSource === "addDrop" ? "补退选阶段尚未开始" : "正选阶段尚未开始"}
              </p>
              <p className="text-xs mt-1 text-gray-400">教务系统发布数据后此处将自动显示</p>
            </div>
          ) : formalSections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <p className="text-sm font-medium text-gray-500">未找到匹配课程</p>
              <p className="text-xs mt-1 text-gray-400">请调整筛选条件或切换学期</p>
            </div>
          ) : (
            <div className="space-y-2">
              {formalSections.map((s, idx) => {
                const sKey = `${s.id}|${s.className}|${s.teacherId}`;
                const isSelected = sKey === selectedSectionKey;
                const warnSlots = scheduleFilter ? unselectedIncludeSlots(s, scheduleFilter) : [];
                const sCourse = selectedPlan ? coursesById?.get(s.id) : undefined;
                const inPlan = !!sCourse && isInPlan(sCourse, selectedPlan);
                return (
                <div
                  key={`${s.id}-${s.className}-${s.teacherId}-${idx}`}
                  onClick={() => onSelectSection?.(s)}
                  className={`rounded-xl border p-4 active:bg-gray-50 transition-colors cursor-pointer shadow-sm ${isSelected ? "bg-red-50/50 border-red-200 border-l-[3px] border-l-red-500" : inPlan ? "bg-indigo-50/30 border-indigo-200 border-l-[3px] border-l-indigo-400" : "bg-white border-gray-100"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-[13px] font-semibold text-gray-800 truncate">{s.name}</h3>
                      <p className="text-xs text-gray-500 mt-1">{s.id} · {s.dept}</p>
                    </div>
                    <span className={`shrink-0 inline-flex items-center justify-center px-2 h-8 rounded-lg text-xs font-bold gap-0.5 ${getCreditColor(s.credits)}`}>
                      {s.credits || "—"}<span className="font-normal opacity-70">学分</span>
                    </span>
                  </div>
                  {(() => {
                    const tags = sCourse
                      ? compactTags(displayTags(sCourse, selectedPlan))
                      : compactTags(s.tags);
                    return tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2.5">
                        {tags.map((t) => <TagBadge key={t} tag={t} />)}
                      </div>
                    );
                  })()}
                  <div className="mt-2.5 text-xs text-gray-500 space-y-1">
                    <InfoRow icon={<TeacherIcon />} label="教师">{s.teacher || "—"}</InfoRow>
                    {s.schedule && (
                      <InfoRow
                        icon={<ClockIcon />}
                        label="时间"
                        tone={warnSlots.length > 0 ? "alert" : "default"}
                        title={warnSlots.length > 0 ? conflictTitle(warnSlots) : s.schedule}
                        trailing={warnSlots.length > 0 ? <ConflictMark slots={warnSlots} /> : undefined}
                      >
                        {compressSchedule(s.schedule)}
                      </InfoRow>
                    )}
                    {s.className && (
                      <InfoRow icon={<ClassIcon />} label="班级" title={s.className}>
                        {compressClassName(s.className)}
                      </InfoRow>
                    )}
                    {s.classroom && <InfoRow icon={<RoomIcon />} label="教室">{s.classroom}</InfoRow>}
                  </div>
                  <div className="mt-2">
                    <StarRating rating={getTeacherAvg?.(s.id, s.teacherId)?.avg ?? null} />
                  </div>
                </div>
                );
              })}
            </div>
          )
        ) : courses.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <svg className="w-14 h-14 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-base font-medium text-gray-500">未找到匹配课程</p>
            <p className="text-sm mt-1 text-gray-400">请调整筛选条件</p>
          </div>
        ) : (
          <>
            {/* Sort bar */}
            <div className="flex items-center gap-2 pb-2.5 px-1 bg-page">
              <span className="text-[11px] text-gray-400 shrink-0">排序</span>
              <button
                onClick={handleSort}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                  ratingSortAsc === null
                    ? "bg-red-50 text-red-500"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                学分
                <span className="text-[10px]">{sortAsc ? "↑" : "↓"}</span>
              </button>
              <button
                onClick={handleRatingSort}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                  ratingSortAsc !== null
                    ? "bg-red-50 text-red-500"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                评分
                {ratingSortAsc !== null && (
                  <span className="text-[10px]">{ratingSortAsc ? "↑" : "↓"}</span>
                )}
              </button>
            </div>
            {/* Cards */}
            <div className="space-y-2">
              {courses.map((c) => {
                const inPlan = isInPlan(c, selectedPlan);
                const tags = compactTags(displayTags(c, selectedPlan));
                return (
                  <div
                    key={c.id}
                    onClick={() => onSelect(c)}
                    className={`rounded-xl border p-4 active:bg-gray-50 transition-colors cursor-pointer shadow-sm ${
                      inPlan
                        ? "bg-indigo-50/30 border-indigo-200 border-l-[3px] border-l-indigo-400"
                        : "bg-white border-gray-100"
                    }`}
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
                      {tags.map((t) => (
                        <TagBadge key={t} tag={t} />
                      ))}
                    </div>
                    {c.teachers.length > 0 && (
                      <p className="text-xs text-gray-500 mt-2.5 truncate">
                        {c.teachers.map((t) => t.name).join(", ")}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <StarRating rating={getCourseAvg?.(c.id) ?? null} />
                      {simMode && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onToggleCart?.(c.id); }}
                          className={`shrink-0 inline-flex items-center gap-1 px-2.5 h-8 rounded-lg text-[12px] font-semibold ${
                            cartHas?.(c.id)
                              ? "bg-red-50 text-red-500 border border-red-200"
                              : "bg-red-500 text-white"
                          }`}
                        >
                          {cartHas?.(c.id) ? (
                            <>
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                              已加入
                            </>
                          ) : (
                            <>
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" d="M12 5v14M5 12h14" /></svg>
                              加入
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
