import { useState } from "react";
import type { Course } from "../types";
import { TagBadge } from "./TagBadge";
import { StarRating } from "./StarRating";
import { StarRatingInput } from "./StarRatingInput";
import { ConfirmModal } from "./ConfirmModal";
import { useRatings } from "../hooks/useRatings";
import { getVoterId } from "../lib/voter";

interface Props {
  course: Course;
  onClose: () => void;
}

export function CourseDetail({ course, onClose }: Props) {
  const { getAvg, refresh } = useRatings(course.id);
  const [ratingTarget, setRatingTarget] = useState<{ teacherId: string; name: string; rating: number } | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!ratingTarget) return;
    setSubmitting(true);
    try {
      await fetch("/api/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: course.id,
          teacherId: ratingTarget.teacherId,
          rating: ratingTarget.rating,
          voterId: getVoterId(),
        }),
      });
      await refresh(course.id);
      setRatingTarget(null);
      setShowModal(false);
    } catch {
      // ignore
    } finally {
      setSubmitting(false);
    }
  };

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
                {course.teachers.map((t, i) => {
                  const avg = getAvg(t.id);
                  const isRating = ratingTarget?.teacherId === t.id;
                  return (
                    <div key={i} className="bg-gray-50 rounded-xl px-4 py-3">
                      <div className="flex items-center gap-3.5">
                        <div className="w-9 h-9 rounded-full bg-red-50 text-red-400 flex items-center justify-center text-sm font-semibold shrink-0">
                          {t.name[0]}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-gray-800">
                            {t.name}
                            <span className="text-gray-400 font-normal ml-1.5 text-xs">{t.gender}</span>
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            教号 {t.id} · {t.dept}
                          </div>
                        </div>
                        {/* Rating button — prominent, centered right */}
                        <button
                          onClick={() => setRatingTarget(isRating ? null : { teacherId: t.id, name: t.name, rating: 0 })}
                          className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors self-center"
                          style={{
                            backgroundColor: isRating ? "#FEE2E2" : avg ? "#FEF3C7" : "#FEE2E2",
                            color: isRating ? "#DC2626" : avg ? "#D97706" : "#DC2626",
                          }}
                        >
                          {isRating ? "收起" : avg ? "修改评分" : "评分"}
                        </button>
                      </div>
                      <div className="flex items-center mt-2 pl-[52px]">
                        <StarRating rating={avg?.avg_rating ?? null} count={avg?.count} />
                      </div>
                      {/* Inline rating input */}
                      {isRating && (
                        <div className="mt-3 pl-[52px]">
                          <StarRatingInput
                            value={ratingTarget.rating}
                            onChange={(v) => setRatingTarget({ ...ratingTarget, rating: v })}
                          />
                          <div className="flex gap-2 mt-2.5">
                            <button
                              onClick={() => setRatingTarget(null)}
                              className="flex-1 py-1.5 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => ratingTarget.rating > 0 && setShowModal(true)}
                              disabled={ratingTarget.rating === 0}
                              className="flex-1 py-1.5 rounded-lg bg-red-500 text-white text-[11px] font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              提交评分
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {course.teachers.length === 0 && (
            <div className="text-center text-gray-400 py-10 text-sm">
              暂无教师信息
            </div>
          )}

          {/* Disclaimer */}
          <p className="text-[11px] text-red-300 text-center leading-relaxed">
            以上评分均为用户主观评价，仅反映其对任课教师在本课程中表现的个人看法，不代表作者立场，仅供参考
          </p>

          <a
            href={`https://xk.jxnu.edu.cn/Step1/AddCourse.aspx?kch=${course.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-2.5 rounded-xl bg-red-500 text-white text-sm font-medium text-center hover:bg-red-600 active:bg-red-700 transition-colors"
          >
            点击跳转此课程选课界面
          </a>
        </div>
      </div>

      <ConfirmModal
        open={showModal}
        teacherName={ratingTarget?.name ?? ""}
        rating={ratingTarget?.rating ?? 0}
        existingRating={ratingTarget ? (getAvg(ratingTarget.teacherId)?.avg_rating ?? null) : null}
        onConfirm={handleSubmit}
        onCancel={() => setShowModal(false)}
        submitting={submitting}
      />
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
