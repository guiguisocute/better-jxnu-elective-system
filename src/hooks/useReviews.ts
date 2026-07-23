import { useCallback, useEffect, useState } from "react";
import {
  subscribeReviews,
  getReviewsVersion,
  getDimsMap,
  getTeacherDims,
  getComments,
  fetchAllReviews,
  fetchCourseReviews,
  fetchReviewComments,
  courseOverallAvg,
} from "../lib/reviewsStore";
import type { ReviewRow, TeacherDims } from "../lib/reviewDimensions";
import { getVoterId } from "../lib/voter";

// 评价系统 V2 hooks。useAllReviews 是列表排序 / AI ratingOf / 评价子页面的统一数据源；
// useCourseReviews 供详情页（挂载即单课程保鲜）；useReviewComments 供评语流。

let fetchedAll = false;
const fetchingCourses = new Set<string>();
const fetchedComments = new Set<string>();

function useReviewsVersion() {
  const [, setV] = useState(getReviewsVersion());
  useEffect(() => subscribeReviews(() => setV(getReviewsVersion())), []);
}

export function useAllReviews() {
  useReviewsVersion();

  useEffect(() => {
    if (fetchedAll) return;
    fetchedAll = true;
    fetchAllReviews().catch(() => {
      fetchedAll = false;
    });
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

  return { getDims, getTeacherOverall, getCourseOverall, dimsMap };
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
  const key = `${courseId ?? ""}|${teacherId ?? ""}`;

  useEffect(() => {
    if (!courseId && !teacherId) return;
    if (fetchedComments.has(key)) return;
    fetchedComments.add(key);
    fetchReviewComments(courseId, teacherId, getVoterId()).catch(() => {
      fetchedComments.delete(key);
    });
  }, [key, courseId, teacherId]);

  const rows: ReviewRow[] | null = getComments(courseId, teacherId);

  const refresh = useCallback(async () => {
    await fetchReviewComments(courseId, teacherId, getVoterId());
  }, [courseId, teacherId]);

  return { rows, refresh };
}
