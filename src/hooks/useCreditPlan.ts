import { useState, useEffect, useMemo, useCallback } from "react";
import type { Course, PlanCourse } from "../types";
import { useMajorRequirements } from "./useMajorRequirements";
import { buildCreditPlan, findRequirement, REQUIRED_NATURES } from "../lib/creditPlan";
import type { CreditInputs } from "../lib/creditPlan";
import type { StudentDetailCourse, StudentScheduleSnapshot } from "../lib/studentRecord";
import { currentPlanTerm, currentCalTerm, enrollYear, termIndexOf, effectiveTermIndex } from "../lib/term";

// 转专业边界：与 creditPlan.ts 同步（仅用于派生 transferEarlyCids，门控由 buildCreditPlan 内部再判一次）。
const TRANSFER_BOUNDARY = 2;

export interface StoredInputs {
  totalEarned: number;
  electiveThisSem: number;
  /** null = 跟随自动推算；数字 = 用户手改后的第N学期。 */
  term: number | null;
  takenMajorElectives: string[];
  excludedRequired: string[];
  /** 转专业学生：前两学期在原专业修读。 */
  transferMode: boolean;
  /** 原专业 planKey（"YYYY级-专业"）；空串 = 未选。 */
  originalPlan: string;
  /** 转专业「已抵」勾选的 cid：未与原专业同 cid、但确认已从其他课抵掉学分的转入专业前两学期必修。 */
  transferOffsetCids: string[];
  /** 是否在核对/核算里显示未来学期必修课（极浅蓝规划进度，仅展示）。 */
  showFutureRequired: boolean;
  /** 引导模式：用户是否已浏览过「勾选已修专业限选」步骤（即使没勾任何课也算完成 → 绿✓）。 */
  visitedMajorElective: boolean;
  /** 学号导入的真实已修 cid（按 isPassed 过滤）。空数组 = 未导入 / 已清空，走启发式。 */
  importedTakenCids: string[];
  /** 学号导入的课程明细快照；用于只评价自己上个学期选过的课。 */
  importedDetailCourses: StudentDetailCourse[];
  /** 学号导入的 D1 真实规划课表；null = 未导入，非 null（含空 items）= 禁止前端反推班级。 */
  importedSchedule: StudentScheduleSnapshot | null;
  /** 一次性迁移标记：修复曾把 2026-09 规划快照误当在读学期而多加 1 的本地状态。 */
  studentSnapshotTermFixV1: boolean;
  /** 校外慕课抵扣：勾选 = +5 学分计入选修。 */
  moocOffset: boolean;
  /** 赛事学分抵扣：输入值（浮点）直接计入选修。 */
  competitionOffset: number;
}

const EMPTY: StoredInputs = {
  totalEarned: 0,
  electiveThisSem: 0,
  term: null,
  takenMajorElectives: [],
  excludedRequired: [],
  transferMode: false,
  originalPlan: "",
  transferOffsetCids: [],
  showFutureRequired: false,
  visitedMajorElective: false,
  importedTakenCids: [],
  importedDetailCourses: [],
  importedSchedule: null,
  studentSnapshotTermFixV1: false,
  moocOffset: false,
  competitionOffset: 0,
};

function simKey(plan: string) {
  return `jxnu.sim.${plan}`;
}

function loadStored(plan: string): StoredInputs {
  if (!plan) return EMPTY;
  try {
    const raw = localStorage.getItem(simKey(plan));
    if (raw) {
      const stored = { ...EMPTY, ...(JSON.parse(raw) as Partial<StoredInputs>) };
      if (!stored.studentSnapshotTermFixV1) {
        const autoTerm = currentPlanTerm(enrollYear(plan), currentCalTerm());
        // 旧版学生快照导入恰好把 term 写成 autoTerm+1（规划学期本身），只迁移这一种已知坏状态。
        if (stored.importedTakenCids.length > 0 && stored.term === autoTerm + 1) {
          stored.term = autoTerm;
        }
        stored.studentSnapshotTermFixV1 = true;
        localStorage.setItem(simKey(plan), JSON.stringify(stored));
      }
      return stored;
    }
  } catch {}
  return EMPTY;
}

/**
 * 学分核算 hook（v2 两块模型：必修 / 选修，term = 在读学期，规划下学期 = term+1）。
 * 已修信息按 planKey 存 localStorage[jxnu.sim.<planKey>]：总学分 / 本学期选修 / 在读第N学期 / 已修限选 / 勾除必修 / 转专业。
 * coursesOf：按任意 planKey 取方案课程清单（转专业匹配用，复用 usePlanCourses 缓存）。
 */
export function useCreditPlan(
  selectedPlan: string,
  cartCourses: Course[],
  planCourses: PlanCourse[],
  coursesOf: (key: string) => PlanCourse[],
) {
  const { requirements, loading } = useMajorRequirements();
  const [stored, setStored] = useState<StoredInputs>(() => loadStored(selectedPlan));

  // 切换培养方案 → 载入该方案对应的已修记录。
  useEffect(() => {
    setStored(loadStored(selectedPlan));
  }, [selectedPlan]);

  const mutate = useCallback(
    (fn: (prev: StoredInputs) => StoredInputs) => {
      setStored((prev) => {
        const next = fn(prev);
        if (selectedPlan) {
          try {
            localStorage.setItem(simKey(selectedPlan), JSON.stringify(next));
          } catch {}
        }
        return next;
      });
    },
    [selectedPlan],
  );

  const autoTerm = useMemo(
    () => currentPlanTerm(enrollYear(selectedPlan), currentCalTerm()),
    [selectedPlan],
  );
  const term = stored.term ?? autoTerm;

  const setTotalEarned = useCallback((v: number) => mutate((p) => ({ ...p, totalEarned: Math.max(0, v) })), [mutate]);
  const setElectiveThisSem = useCallback((v: number) => mutate((p) => ({ ...p, electiveThisSem: Math.max(0, v) })), [mutate]);
  const setTerm = useCallback((v: number | null) => mutate((p) => ({ ...p, term: v })), [mutate]);
  const toggleMajorElective = useCallback(
    (cid: string) =>
      mutate((p) => {
        const set = new Set(p.takenMajorElectives);
        if (set.has(cid)) set.delete(cid);
        else set.add(cid);
        return { ...p, takenMajorElectives: [...set] };
      }),
    [mutate],
  );
  const toggleExcludedRequired = useCallback(
    (cid: string) =>
      mutate((p) => {
        const set = new Set(p.excludedRequired);
        if (set.has(cid)) set.delete(cid);
        else set.add(cid);
        return { ...p, excludedRequired: [...set] };
      }),
    [mutate],
  );
  const setTransferMode = useCallback(
    (v: boolean) => mutate((p) => ({ ...p, transferMode: v })),
    [mutate],
  );
  const setOriginalPlan = useCallback(
    (v: string) => mutate((p) => ({ ...p, originalPlan: v })),
    [mutate],
  );
  const setShowFutureRequired = useCallback(
    (v: boolean) => mutate((p) => ({ ...p, showFutureRequired: v })),
    [mutate],
  );
  // 引导模式：用户进入"勾选已修专业限选"步骤后置 true，让该步骤即使空勾也能打绿✓。
  const setVisitedMajorElective = useCallback(
    (v: boolean) => mutate((p) => ({ ...p, visitedMajorElective: v })),
    [mutate],
  );
  // 校外慕课抵扣开关：勾选 = +5 学分到选修。
  const setMoocOffset = useCallback(
    (v: boolean) => mutate((p) => ({ ...p, moocOffset: v })),
    [mutate],
  );
  // 赛事学分抵扣（浮点）：值直接加到选修；负值钳到 0。
  const setCompetitionOffset = useCallback(
    (v: number) => mutate((p) => ({ ...p, competitionOffset: Number.isFinite(v) ? Math.max(0, v) : 0 })),
    [mutate],
  );
  // 转专业「已抵」勾选：未匹配前两学期必修中，用户确认已从其他课抵掉学分的 cid。
  const toggleTransferOffset = useCallback(
    (cid: string) =>
      mutate((p) => {
        const set = new Set(p.transferOffsetCids);
        if (set.has(cid)) set.delete(cid);
        else set.add(cid);
        return { ...p, transferOffsetCids: [...set] };
      }),
    [mutate],
  );

  // 整批设置专业限选已修（学号导入后用 detailCourses ∩ 限选课 cids 一次性回填）。
  const setTakenMajorElectives = useCallback(
    (ids: string[]) => mutate((p) => ({ ...p, takenMajorElectives: [...new Set(ids)] })),
    [mutate],
  );

  // 整批设置排除必修（学号导入后用「培养方案必修全集 − 档案已修」一次性回填核对必修）。
  const setExcludedRequired = useCallback(
    (ids: string[]) => mutate((p) => ({ ...p, excludedRequired: [...new Set(ids)] })),
    [mutate],
  );

  /**
   * 整体导入 StoredInputs（方案分享码恢复用）—— 指定 plan 的 localStorage 直接覆写并 setStored。
   * 与 selectedPlan 当前值无关：调用方负责先把 selectedPlan 切到 plan，再 importInputs。
   */
  const importInputs = useCallback(
    (plan: string, next: Partial<StoredInputs>) => {
      if (!plan) return;
      const merged: StoredInputs = { ...EMPTY, ...next };
      try {
        localStorage.setItem(simKey(plan), JSON.stringify(merged));
      } catch {}
      if (plan === selectedPlan) setStored(merged);
    },
    [selectedPlan],
  );

  const requirement = useMemo(
    () => findRequirement(requirements, selectedPlan),
    [requirements, selectedPlan],
  );

  // 原专业课程清单（懒加载缓存命中即可，未加载返回 []）。
  const originalCourses = useMemo(
    () => coursesOf(stored.originalPlan),
    [coursesOf, stored.originalPlan],
  );

  // 兜底：勾了转专业但没选原专业 / 选了同一个专业 / 原专业课程清单空 → 视为未开启，避免把前两学期必修误算成缺口。
  const transferActive =
    stored.transferMode &&
    !!stored.originalPlan &&
    stored.originalPlan !== selectedPlan &&
    originalCourses.length > 0;

  // 原专业前 TRANSFER_BOUNDARY 学期 cid 集合 —— 与转入专业同 cid 即视为"已抵"。
  const transferEarlyCids = useMemo(() => {
    if (!transferActive) return new Set<string>();
    const set = new Set<string>();
    for (const c of originalCourses) {
      const ti = termIndexOf(c.semester);
      if (ti > 0 && ti <= TRANSFER_BOUNDARY) set.add(c.cid);
    }
    return set;
  }, [transferActive, originalCourses]);

  const inputs = useMemo<CreditInputs>(
    () => ({
      totalEarned: stored.totalEarned,
      electiveThisSem: stored.electiveThisSem,
      term,
      takenMajorElectives: new Set(stored.takenMajorElectives),
      excludedRequired: new Set(stored.excludedRequired),
      transferMode: transferActive,
      transferEarlyCids,
      transferOffsetCids: new Set(stored.transferOffsetCids),
      showFutureRequired: stored.showFutureRequired,
      moocOffset: stored.moocOffset,
      competitionOffset: stored.competitionOffset,
    }),
    [stored, term, transferActive, transferEarlyCids],
  );

  const view = useMemo(
    () => buildCreditPlan(requirement, planCourses, cartCourses, selectedPlan, inputs),
    [requirement, planCourses, cartCourses, selectedPlan, inputs],
  );

  const transferEarlyCidArray = useMemo(() => [...transferEarlyCids], [transferEarlyCids]);

  // 已修课程 cid 集合（驱动「隐藏已修课程」筛选）。两支：
  //   - 真实分支（importedTakenCids 非空）：以学号导入的档案为准（含公选/任选/方案外课），
  //     仍叠加在读必修（档案无成绩，本学期课不在 detailCourses）；用户 untick「未修」可减去。
  //   - 启发式分支：本方案 ti ≤ term 必修（默认按方案推算为已修/在读）。
  // 两支都额外 union 专业限选已勾 + 转专业匹配 cid。
  // 不含 nextSemRequired（下学期要选的，不应被隐藏）。
  const takenCids = useMemo(() => {
    const set = new Set<string>();
    const excluded = new Set(stored.excludedRequired);
    const offset = new Set(stored.transferOffsetCids);
    const imported = stored.importedTakenCids;

    if (imported.length > 0) {
      for (const cid of imported) {
        if (excluded.has(cid)) continue;
        set.add(cid);
      }
      // 在读学期必修补齐（档案里没成绩）。
      for (const pc of planCourses) {
        if (!REQUIRED_NATURES.includes(pc.nature)) continue;
        const ti = effectiveTermIndex(pc.cid, pc.semester);
        if (ti !== term) continue;
        if (excluded.has(pc.cid)) continue;
        if (transferActive && ti <= 2 && !transferEarlyCids.has(pc.cid) && !offset.has(pc.cid)) continue;
        set.add(pc.cid);
      }
    } else {
      for (const pc of planCourses) {
        if (!REQUIRED_NATURES.includes(pc.nature)) continue;
        // 延迟结算课（形势与政策）按结算学期算 —— 第7学期前不算已修，不被「隐藏已修课程」误隐。
        const ti = effectiveTermIndex(pc.cid, pc.semester);
        if (ti <= 0 || ti > term) continue;
        if (excluded.has(pc.cid)) continue;
        // 转专业前两学期未检测到：默认是缺口，不算已修；勾「已抵」(offset) 才算已修。
        if (transferActive && ti <= 2 && !transferEarlyCids.has(pc.cid) && !offset.has(pc.cid)) continue;
        set.add(pc.cid);
      }
    }

    for (const cid of stored.takenMajorElectives) set.add(cid);
    for (const cid of transferEarlyCids) set.add(cid);
    return set;
  }, [planCourses, term, stored.excludedRequired, stored.takenMajorElectives, stored.transferOffsetCids, stored.importedTakenCids, transferActive, transferEarlyCids]);

  return {
    view,
    requirement,
    term,
    autoTerm,
    stored,
    setTotalEarned,
    setElectiveThisSem,
    setTerm,
    toggleMajorElective,
    toggleExcludedRequired,
    setTransferMode,
    setOriginalPlan,
    setShowFutureRequired,
    setVisitedMajorElective,
    toggleTransferOffset,
    setTakenMajorElectives,
    setExcludedRequired,
    importInputs,
    transferEarlyCids: transferEarlyCidArray,
    transferActive,
    takenCids,
    setMoocOffset,
    setCompetitionOffset,
    loading,
  };
}
