import { useState, useRef, useLayoutEffect, useEffect } from "react";
import { createPortal } from "react-dom";
import { DAY_LABELS, SLOT_KEYS, slotLabel, dayLabel } from "../../lib/scheduleParse";
import type { PlacedCourse, PlacedKind, PlacedOption } from "../../lib/schedulePlacement";
import { natureColor } from "../../lib/creditPlan";
import { tagColorClasses } from "../TagBadge";
import { CopyIdButton } from "../CopyIdButton";

// 模拟选课周课表：占用格按所选培养方案下的课程性质着色（与标签色一致）；
// 同格 ≥2 门 → 冲突浅红斜条纹；必修课在右上角加蓝色「必」角标。
// 点占用格 → 弹「可操作」mini 浮窗：换班 / 取消必修 / 移出待选 / 解冲突。下方另有常驻选班列表。
// 浮窗 Portal 到 body：面板/弹窗祖先有 transform，会劫持 position:fixed 的包含块导致错位。
// 无开课时段数据的课在网格下方单列。

const DAYS = 7;

const SLOT_LABEL: Record<string, string> = {
  "1-2": "1-2", "3": "3", "4": "4", "5": "5", "6-7": "6-7", "8-9": "8-9", "晚上": "晚",
};

// 浮窗 / 选班列表里的「本学期必修 / 待选」类型标签按 kind 区分（required / cart 不同语义）。
// 小圆点改随课程性质（natureColor），与格子/标签同色；类型标签用静态 tailwind chip 类（比 inline 10% alpha 易辨认）。
const KIND_STYLE: Record<PlacedKind, { label: string; chip: string }> = {
  required: { label: "本学期必修", chip: "bg-blue-100 text-blue-700" },
  cart: { label: "待选", chip: "bg-red-100 text-red-700" },
};

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

// 浮窗表头用：把 cellKey("day,slot") 转人话，如「周三 · 6-7节」。
function cellHeaderLabel(key: string): string {
  const [dStr, slot] = key.split(",");
  const d = Number(dStr);
  const slotText = slot === "晚上" ? "晚上" : `${slot}节`;
  return `${dayLabel(d)} · ${slotText}`;
}

// 评估「把某门课换到某个班级 option」会不会与其它已落格课程时段冲突：
// 拿该 option 的全部 slots 去比对当前 cellMap（网格已占格），命中的占用课里排除该课自身，
// 即为换上去后会撞车的其它课。返回去重后的冲突课程名（空数组 = 该班级与其它课无时段冲突）。
function conflictNamesFor(
  cellMap: Map<string, PlacedCourse[]>,
  course: PlacedCourse,
  option: PlacedOption,
): string[] {
  const byCid = new Map<string, string>(); // cid → name，跨多个 slot 命中同一门课时去重
  for (const m of option.slots) {
    const occ = cellMap.get(`${m.day},${m.slot}`);
    if (!occ) continue;
    for (const other of occ) {
      if (other.cid !== course.cid) byCid.set(other.cid, other.name);
    }
  }
  return [...byCid.values()];
}

// 换班 chip（浮窗 / 选班列表共用）：选中态深底；未选中按「换上去会不会撞别的课」着色 ——
// 无冲突＝绿点 + 中性底（可放心换）；有冲突＝红点 + 浅红底，并标出会撞哪一门（"撞 X"，多门时 +N）。
function SectionChip({
  option,
  active,
  conflicts,
  onChoose,
}: {
  option: PlacedOption;
  active: boolean;
  conflicts: string[];
  onChoose: () => void;
}) {
  const hasConflict = conflicts.length > 0;
  const slotsText = option.slots.map((m) => slotLabel(m)).join(" / ");
  const title =
    `${option.className ?? ""} · ${option.teacher ?? ""} · ${slotsText}` +
    (hasConflict ? ` · 换上后与「${conflicts.join("、")}」时段冲突` : " · 与其它课无时段冲突，可放心换");
  return (
    <button
      onClick={onChoose}
      title={title}
      className={`px-2 py-1 rounded-md border text-left max-w-[150px] transition-colors ${
        active
          ? "bg-[#1F2937] border-gray-800 text-white dark:bg-[#30363D] dark:border-[#484F58]"
          : hasConflict
            ? "bg-rose-50 border-rose-200 text-rose-700 hover:border-rose-300"
            : "bg-white border-gray-200 text-gray-600 hover:border-gray-400"
      }`}
    >
      <span className="flex items-center gap-1">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: hasConflict ? "#E11D48" : "#10B981" }}
        />
        <span className="min-w-0 truncate text-[10px] font-semibold">{option.teacher || option.className || "班级"}</span>
      </span>
      <span className={`block text-[9px] truncate ${active ? "text-white/75" : hasConflict ? "text-rose-500" : "text-gray-400"}`}>
        {slotsText}
      </span>
      {hasConflict && (
        <span className={`block text-[9px] font-medium truncate ${active ? "text-rose-300" : "text-rose-600"}`}>
          撞 {conflicts[0]}{conflicts.length > 1 ? ` +${conflicts.length - 1}` : ""}
        </span>
      )}
    </button>
  );
}

interface PopState {
  key: string;
  anchor: DOMRect;
}

interface Props {
  placed: PlacedCourse[];
  /** 选班回调：切换某课落格到指定班级。 */
  onChooseSection?: (cid: string, optionKey: string) => void;
  /** 取消本学期必修（由上层弹确认窗）。 */
  onCancelRequired?: (cid: string, name: string) => void;
  /** 移出待选清单。 */
  onRemoveCart?: (cid: string) => void;
}

export function SimScheduleGrid({ placed, onChooseSection, onCancelRequired, onRemoveCart }: Props) {
  const [pop, setPop] = useState<PopState | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ key: string; left: number; top: number } | null>(null);
  // 浮窗内某门课「换班 chips」是否展开全部（班级特别多时默认折叠）。
  const [expandedChips, setExpandedChips] = useState<Set<string>>(new Set());
  const toggleChips = (cid: string) =>
    setExpandedChips((s) => {
      const n = new Set(s);
      if (n.has(cid)) n.delete(cid); else n.add(cid);
      return n;
    });

  // cellKey("day,slot") → 占用该格的课
  const cellMap = new Map<string, PlacedCourse[]>();
  for (const c of placed) {
    if (c.status !== "placed") continue;
    for (const m of c.slots) {
      const key = `${m.day},${m.slot}`;
      const arr = cellMap.get(key) ?? [];
      arr.push(c);
      cellMap.set(key, arr);
    }
  }

  // 浮窗内/列表高亮所依赖的「当前选中格的课」+ 这些课占用的全部格。
  const popCourses = pop ? cellMap.get(pop.key) ?? [] : [];
  const highlight = new Set<string>();
  for (const c of popCourses) for (const m of c.slots) highlight.add(`${m.day},${m.slot}`);

  // 选班把课移到别的格后，原格可能已空 → 关掉浮窗。
  useEffect(() => {
    if (pop && (cellMap.get(pop.key)?.length ?? 0) === 0) setPop(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop, placed]);

  // 换格子时重置 chips 展开态。
  useEffect(() => { setExpandedChips(new Set()); }, [pop?.key]);

  // 浮窗定位：测量后按视口坐标摆放（优先右侧，溢出翻左；夹在屏内）。
  useLayoutEffect(() => {
    if (!pop || !popRef.current) return;
    const a = pop.anchor;
    const pr = popRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = 8;
    let left = a.right + m;
    if (left + pr.width > vw - m) left = a.left - pr.width - m;
    left = clamp(left, m, Math.max(m, vw - pr.width - m));
    let top = a.top;
    top = clamp(top, m, Math.max(m, vh - pr.height - m));
    setCoords({ key: pop.key, left, top });
  }, [pop, placed, expandedChips]);

  // 浮窗打开时锁主页面滚动（含引导模式）：避免误触主滚动条把页面滚走、连带关掉浮窗。
  // 不再手动补 paddingRight —— 全局 html{scrollbar-gutter:stable} 已恒定预留滚动条槽位，
  // 锁滚动后滚动条消失但槽位仍在、布局宽度不变；这里再补 padding 会双重补偿，把 fixed 居中的引导弹窗推偏。
  useEffect(() => {
    if (!pop) return;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => { body.style.overflow = prevOverflow; };
  }, [pop]);

  // 改窗 / Esc → 关浮窗；滚动 → 仅当滚的是「浮窗之外」(锚点所在容器滚动)才关，浮窗自身内部滚动不关。
  useEffect(() => {
    if (!pop) return;
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      setPop(null);
    };
    const close = () => setPop(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(null); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [pop]);

  const rows: Array<{ kind: "lunch" } | { kind: "slot"; slot: string }> = [];
  for (const s of SLOT_KEYS) {
    if (s === "6-7") rows.push({ kind: "lunch" });
    rows.push({ kind: "slot", slot: s });
  }

  const popReady = coords?.key === pop?.key;
  const conflict = popCourses.length > 1;
  // 浮窗最大高度（兜底滚动）：超长 chips 列表不撑爆屏幕。
  const popMaxH = typeof window !== "undefined" ? Math.round(window.innerHeight * 0.8) : 600;
  const CHIPS_COLLAPSE_AT = 12; // 班级超过这个数默认折叠

  return (
    <div>
      <div className="select-none rounded-lg overflow-hidden border border-gray-200 bg-white">
        {/* 表头 */}
        <div className="flex bg-gray-50 border-b border-gray-200">
          <div className="shrink-0 w-7" />
          <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 2, padding: 2 }}>
            {DAY_LABELS.slice(0, DAYS).map((d, i) => (
              <div key={i} className="flex items-center justify-center text-[10px] text-gray-500 font-medium py-0.5">
                周{d}
              </div>
            ))}
          </div>
        </div>

        {/* 表身：底色 = 标签所在背景同色（亮 #F0F1EF / 暗 #22272E），让半透明占用格合成出来的颜色与课程标签一致。
            必须走 class 而非 inline style —— inline 优先级最高，.dark 补丁层盖不掉，否则暗色下整片仍是亮米底。 */}
        <div className="flex flex-col bg-[#F0F1EF] dark:bg-[#22272E]" style={{ gap: 2, padding: 2 }}>
          {rows.map((row) =>
            row.kind === "lunch" ? (
              <div
                key="lunch"
                className="rounded flex items-center justify-center text-[10px] bg-gray-50 text-gray-400"
                style={{ height: 12, letterSpacing: "0.5em" }}
              >
                中午
              </div>
            ) : (
              <div key={row.slot} className="flex" style={{ gap: 2 }}>
                <div className="shrink-0 w-7 flex items-center justify-center text-[9px] font-mono text-gray-500 bg-gray-50 rounded">
                  {SLOT_LABEL[row.slot]}
                </div>
                <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 2 }}>
                  {Array.from({ length: DAYS }).map((_, d) => {
                    const key = `${d},${row.slot}`;
                    const occ = cellMap.get(key) ?? [];
                    const cellConflict = occ.length > 1;
                    const selected = pop?.key === key;
                    const dimHL = highlight.has(key);
                    if (occ.length === 0) {
                      return <div key={d} className="rounded bg-white" style={{ minHeight: 52 }} />;
                    }
                    const first = occ[0];
                    const hasRequired = occ.some((c) => c.kind === "required");
                    // 格子套用与「课程标签」完全一致的配色（tagColorClasses：浅底 X-50 + 同色边框 X-200 + 深色文字 X-600/700）：
                    // 深文字保证可读，浅底不刺眼，与列表里的 TagBadge 视觉统一。冲突格走斜条纹。
                    const occClass = tagColorClasses(first.nature);
                    return (
                      <button
                        key={d}
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setPop((p) => (p?.key === key ? null : { key, anchor: rect }));
                        }}
                        title={occ.map((c) => `${c.name}${c.teacher ? ` · ${c.teacher}` : ""}${c.classroom ? ` · ${c.classroom}` : ""}`).join("\n")}
                        className={`relative rounded px-1 py-1 flex flex-col justify-center overflow-hidden text-left transition-all duration-200 ease-out ${
                          cellConflict ? "sim-cell-conflict text-rose-600" : `border ${occClass}`
                        } ${selected ? "z-10 ring-[3px] ring-current/65 ring-offset-2 ring-offset-white shadow-lg" : dimHL ? "ring-2 ring-current/30" : ""}`}
                        style={{ minHeight: 52 }}
                      >
                        {/* 必修角标 */}
                        {hasRequired && (
                          <span
                            className={`absolute top-0 right-0 px-1 text-[8px] font-bold leading-tight rounded-bl ${
                              cellConflict ? "bg-rose-500 text-white" : "bg-blue-500 text-white"
                            }`}
                          >
                            必
                          </span>
                        )}
                        {cellConflict ? (
                          <span className="text-[10px] font-bold text-center">冲突 {occ.length}</span>
                        ) : (
                          <>
                            <span className="text-[10px] leading-tight font-semibold line-clamp-2">{first.name}</span>
                            {first.teacher && (
                              <span className="text-[9px] leading-tight opacity-80 truncate mt-0.5">{first.teacher}</span>
                            )}
                            {first.classroom && (
                              <span className="text-[9px] leading-tight opacity-60 truncate">{first.classroom}</span>
                            )}
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ),
          )}
        </div>
      </div>

      {/* 图例 */}
      <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px] text-gray-500">
        <span className="inline-flex items-center gap-1"><span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-blue-500 text-white text-[7px] font-bold">必</span>必修标记</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm sim-cell-conflict border border-rose-200" /><span className="text-rose-600">时段冲突</span></span>
        <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full" style={{ background: "#10B981" }} />换班无冲突</span>
        <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full" style={{ background: "#E11D48" }} />换后撞课</span>
        <span className="text-gray-400">· 点击可换班/退选</span>
      </div>

      {/* 点格 mini 浮窗（只读：详情 / 冲突两门）。Portal 到 body 避开 transform 祖先。 */}
      {pop && popCourses.length > 0 && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setPop(null)} />
          <div
            ref={popRef}
            className="fixed z-[61] w-64 rounded-xl bg-white border border-gray-200 shadow-[0_12px_36px_rgba(0,0,0,0.18)] overflow-hidden flex flex-col"
            style={{
              left: popReady ? coords!.left : pop.anchor.right + 8,
              top: popReady ? coords!.top : pop.anchor.top,
              visibility: popReady ? "visible" : "hidden",
              maxHeight: popMaxH,
            }}
          >
            {/* 表头 */}
            <div className={`shrink-0 px-3 py-2 flex items-center gap-1.5 border-b ${conflict ? "bg-rose-50 border-rose-100" : "bg-gray-50 border-gray-100"}`}>
              {conflict ? (
                <span className="inline-flex items-center gap-1 text-[12px] font-bold text-rose-600">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.86l-8.5 14.7A1 1 0 002.66 20h18.68a1 1 0 00.86-1.5l-8.5-14.7a1 1 0 00-1.73 0z" />
                  </svg>
                  时段冲突
                </span>
              ) : (
                <span className="text-[12px] font-bold text-gray-700">{cellHeaderLabel(pop.key)}</span>
              )}
              {conflict && <span className="text-[11px] text-rose-400 font-medium">{cellHeaderLabel(pop.key)}</span>}
              <button
                onClick={() => setPop(null)}
                className="ml-auto -mr-1 w-5 h-5 inline-flex items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                aria-label="关闭"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 课程卡（冲突时并列两门）—— 可操作：换班 / 取消必修 / 移出待选。兜底滚动。 */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain divide-y divide-gray-100">
              {popCourses.map((c) => {
                const s = KIND_STYLE[c.kind];
                const chipsExpanded = expandedChips.has(c.cid);
                const collapsible = c.options.length > CHIPS_COLLAPSE_AT;
                const shownOptions = collapsible && !chipsExpanded ? c.options.slice(0, CHIPS_COLLAPSE_AT) : c.options;
                return (
                  <div key={c.cid} className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: natureColor(c.nature) }} />
                      <span className="text-[12px] font-semibold text-gray-800 flex-1 truncate">{c.name}</span>
                      <span className="flex items-center gap-1 shrink-0">
                        <span className="text-[11px] text-gray-400 font-mono">{c.cid}</span>
                        <CopyIdButton text={c.cid} className="w-4 h-4" />
                      </span>
                      <span className={`text-[10px] font-bold px-1 rounded shrink-0 ${s.chip}`}>{s.label}</span>
                      <span className="text-[11px] font-bold text-gray-600 shrink-0">{c.credits}分</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500 pl-3.5">
                      {c.teacher && <span>教师 {c.teacher}</span>}
                      {c.classroom && <span>教室 {c.classroom}</span>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-500 pl-3.5">
                      时段 {c.slots.map((m) => slotLabel(m)).join(" / ")}
                    </div>

                    {/* 换班 chips（班级多则折叠，超长由浮窗滚动兜底） */}
                    {c.options.length > 1 && (
                      <div className="mt-1.5 pl-3.5">
                        <div className="text-[10px] text-gray-400 mb-1">换班 · {c.options.length} 个班级{c.srcSem ? ` · ${c.srcSem}` : ""}</div>
                        <div className="flex flex-wrap gap-1">
                          {shownOptions.map((o) => (
                            <SectionChip
                              key={o.key}
                              option={o}
                              active={o.key === c.activeKey}
                              conflicts={conflictNamesFor(cellMap, c, o)}
                              onChoose={() => onChooseSection?.(c.cid, o.key)}
                            />
                          ))}
                        </div>
                        {collapsible && (
                          <button
                            onClick={() => toggleChips(c.cid)}
                            className="mt-1 text-[10px] font-medium text-gray-500 hover:text-gray-800"
                          >
                            {chipsExpanded ? "收起" : `展开全部 ${c.options.length} 个班级`}
                          </button>
                        )}
                      </div>
                    )}

                    {/* 操作：取消必修 / 移出待选 */}
                    <div className="mt-1.5 pl-3.5">
                      {c.kind === "required" ? (
                        <button
                          onClick={() => onCancelRequired?.(c.cid, c.name)}
                          className="inline-flex items-center gap-1 text-[10px] text-gray-400 border border-gray-200 rounded-md px-2 py-1 hover:text-rose-600 hover:border-rose-300 transition-colors"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                          取消必修
                        </button>
                      ) : (
                        <button
                          onClick={() => onRemoveCart?.(c.cid)}
                          className="inline-flex items-center gap-1 text-[10px] text-gray-400 border border-gray-200 rounded-md px-2 py-1 hover:text-rose-600 hover:border-rose-300 transition-colors"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" /></svg>
                          移出待选
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {conflict && (
              <div className="shrink-0 px-3 py-2 bg-rose-50/60 text-[10px] text-rose-600 leading-relaxed border-t border-rose-100">
                两门课时段重叠。换班或移除其一即可错开时间。
              </div>
            )}
          </div>
        </>,
        document.body,
      )}

      {/* 选班列表：每门课选哪个班级（默认表格顺序第一个命中），常驻可见 */}
      {placed.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-bold text-gray-600 mb-1.5">
            选班 · 共 {placed.length} 门
            <span className="ml-1 font-normal text-gray-400">点班级切换上课时段</span>
          </div>
          <div className="space-y-1.5">
            {placed.map((c) => {
              const s = KIND_STYLE[c.kind];
              const isHL = popCourses.some((sc) => sc.cid === c.cid);
              const chipsExpanded = expandedChips.has(c.cid);
              const collapsible = c.options.length > CHIPS_COLLAPSE_AT;
              const shownOptions = collapsible && !chipsExpanded ? c.options.slice(0, CHIPS_COLLAPSE_AT) : c.options;
              return (
                <div
                  key={c.cid}
                  className={`rounded-lg border px-2.5 py-2 transition-colors ${
                    isHL ? "border-gray-800 bg-gray-50 dark:border-[#484F58]" : "border-gray-100 bg-white"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: natureColor(c.nature) }} />
                    <span className="text-[12px] font-semibold text-gray-800 flex-1 truncate">{c.name}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="text-[11px] text-gray-400 font-mono">{c.cid}</span>
                      <CopyIdButton text={c.cid} className="w-4 h-4" />
                    </span>
                    <span className={`text-[10px] font-bold px-1 rounded shrink-0 ${s.chip}`}>{s.label}</span>
                    <span className="text-[11px] font-bold text-gray-600 shrink-0">{c.credits}分</span>
                    {c.kind === "required" ? (
                      <button
                        onClick={() => onCancelRequired?.(c.cid, c.name)}
                        title="取消这门必修"
                        className="text-[10px] text-gray-400 border border-gray-200 rounded-md px-1.5 py-0.5 hover:text-rose-600 hover:border-rose-300 transition-colors shrink-0"
                      >
                        取消
                      </button>
                    ) : (
                      <button
                        onClick={() => onRemoveCart?.(c.cid)}
                        title="移出待选清单"
                        className="text-[10px] text-gray-400 border border-gray-200 rounded-md px-1.5 py-0.5 hover:text-rose-600 hover:border-rose-300 transition-colors shrink-0"
                      >
                        移出
                      </button>
                    )}
                  </div>

                  {c.status !== "placed" ? (
                    <div className="mt-1 pl-3.5 text-[11px] text-gray-400">课表待发布（规划学期开课安排尚未发布）</div>
                  ) : (
                    <>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500 pl-3.5">
                        {c.teacher && <span>教师 {c.teacher}</span>}
                        {c.classroom && <span>教室 {c.classroom}</span>}
                        <span>时段 {c.slots.map((m) => slotLabel(m)).join(" / ")}</span>
                      </div>
                      {c.options.length > 1 ? (
                        <div className="mt-1.5 pl-3.5">
                          <div className="text-[10px] text-gray-400 mb-1">
                            可选 {c.options.length} 个班级{c.srcSem ? ` · ${c.srcSem}` : ""}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {shownOptions.map((o) => (
                              <SectionChip
                                key={o.key}
                                option={o}
                                active={o.key === c.activeKey}
                                conflicts={conflictNamesFor(cellMap, c, o)}
                                onChoose={() => onChooseSection?.(c.cid, o.key)}
                              />
                            ))}
                          </div>
                          {collapsible && (
                            <button
                              onClick={() => toggleChips(c.cid)}
                              className="mt-1 text-[10px] font-medium text-gray-500 hover:text-gray-800"
                            >
                              {chipsExpanded ? "收起" : `展开全部 ${c.options.length} 个班级`}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="mt-1 pl-3.5 text-[10px] text-gray-300">仅一个班级，无需选班</div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {placed.length === 0 && (
        <div className="mt-3 text-[12px] text-gray-400 text-center py-6">
          暂无可排课程（先在列表加课，或确认培养方案与学期）。
        </div>
      )}
    </div>
  );
}
