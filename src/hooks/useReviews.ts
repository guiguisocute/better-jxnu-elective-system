import { useCallback, useEffect, useState } from "react";
import {
  subscribeReviews,
  getReviewsVersion,
  getDimsMap,
  getTeacherDims,
  getComments,
  getAllReviewsStatus,
  getCommentsStatus,
  ensureAllReviews,
  ensureReviewComments,
  fetchCourseReviews,
  fetchReviewComments,
  courseOverallAvg,
  type LoadStatus,
} from "../lib/reviewsStore";
import type { ReviewRow, TeacherDims } from "../lib/reviewDimensions";
import { getVoterId } from "../lib/voter";

// 评价系统 V2 hooks。useAllReviews 是列表排序 / AI ratingOf / 评价子页面的统一数据源；
// useCourseReviews 供详情页（挂载即单课程保鲜）；useReviewComments 供评语流。
// 加载去重/失败重试全部由 store 的状态机负责（ensure* 幂等）：挂载即 ensure，
// error 态下再次挂载或点重试都会重新拉取 —— 不再用本文件旧版的模块级 once-flag
// （那套 flag 在静默失败时永久卡死、在网络异常时只有重新挂载才恢复，且从不通知 UI）。

const fetchingCourses = new Set<string>();

function useReviewsVersion() {
  const [, setV] = useState(getReviewsVersion());
  useEffect(() => subscribeReviews(() => setV(getReviewsVersion())), []);
}

export function useAllReviews() {
  useReviewsVersion();

  useEffect(() => {
    ensureAllReviews();
  }, []);

  const getDims = useCallback(
    (courseId: string, teacherId: string): TeacherDims | null => getTeacherDims(courseId, teacherId),
    []
  );

  /** 旧 getTeacherAvg 的替代：overall 维度 {avg,count}（喂 HomePage 排序 / AI ratingOf） */
  const getTeacherOverall = useCallback((courseId: string, teacherId: string) => {
    const o = getTeacherDims(courseId, teacherId)?.overall;
    return o && o.count > 0 ? { avg: o.avg, count: o.count } : null;
  }, []);

  /** 旧 getCourseAvg 的替代：课程内所有教师 overall 均值 */
  const getCourseOverall = useCallback((courseId: string): number | null => courseOverallAvg(courseId), []);

  /** 评价子页面枚举用：全量 dims Map（只读） */
  const dimsMap = getDimsMap();

  return {
    getDims,
    getTeacherOverall,
    getCourseOverall,
    dimsMap,
    /** 全站聚合加载状态（idle 视同 loading —— effect 马上会发起） */
    status: getAllReviewsStatus(),
    /** 失败后手动重试（幂等；loading/ready 时是 no-op） */
    retry: ensureAllReviews,
  };
}

export function useCourseReviews(courseId: string | undefined) {
  useReviewsVersion();

  useEffect(() => {
    if (!courseId || fetchingCourses.has(courseId)) return;
    fetchingCourses.add(courseId);
    fetchCourseReviews(courseId).finally(() => {
      fetchingCourses.delete(courseId);
    });
  }, [courseId]);

  const getDims = useCallback(
    (teacherId: string): TeacherDims | null => (courseId ? getTeacherDims(courseId, teacherId) : null),
    [courseId]
  );

  const refresh = useCallback(async () => {
    if (courseId) await fetchCourseReviews(courseId);
  }, [courseId]);

  return { getDims, refresh };
}

/** 评语流：courseId 必传 teacherId 可省（课程全部教师）；或只传 teacherId（跨课程按老师）。 */
export function useReviewComments(courseId: string | undefined, teacherId: string | undefined) {
  useReviewsVersion();

  useEffect(() => {
    if (!courseId && !teacherId) return; // 两者都空 = 广场流，由 useReviewFeed 负责
    ensureReviewComments(courseId, teacherId, getVoterId());
  }, [courseId, teacherId]);

  const rows: ReviewRow[] | null = getComments(courseId, teacherId);
  const status: LoadStatus = getCommentsStatus(courseId, teacherId);

  const refresh = useCallback(async () => {
    await fetchReviewComments(courseId, teacherId, getVoterId());
  }, [courseId, teacherId]);

  return { rows, status, refresh };
}

/** 广场：全站最新评价流（无课程/教师过滤，updated_at 倒序） */
export function useReviewFeed() {
  useReviewsVersion();

  useEffect(() => {
    ensureReviewComments(undefined, undefined, getVoterId());
  }, []);

  const rows: ReviewRow[] | null = getComments(undefined, undefined);
  const status: LoadStatus = getCommentsStatus(undefined, undefined);

  const refresh = useCallback(async () => {
    await fetchReviewComments(undefined, undefined, getVoterId());
  }, []);

  return { rows, status, refresh };
}
