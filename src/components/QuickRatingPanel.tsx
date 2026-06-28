import { useEffect, useMemo, useState } from "react";
import type { FormalSection } from "../types";
import { useRatings } from "../hooks/useRatings";
import { getVoterId } from "../lib/voter";
import { checkMyRating, deleteMyRating, removeOptimistic } from "../lib/ratingsStore";
import { StarRating } from "./StarRating";
import { StarRatingInput } from "./StarRatingInput";
import { ConfirmModal } from "./ConfirmModal";

interface Props {
  sections: FormalSection[];
}

function sectionKey(s: FormalSection) {
  return `${s.id}|${s.className}|${s.teacherId}`;
}

function QuickRatingRow({ section }: { section: FormalSection }) {
  const { getAvg, applyOptimistic, refresh } = useRatings(section.id);
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [myRating, setMyRating] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const hasTeacherId = Boolean(section.teacherId);
  const avg = hasTeacherId ? getAvg(section.teacherId) : null;

  useEffect(() => {
    if (!hasTeacherId) return;
    const voterId = getVoterId();
    checkMyRating(section.id, section.teacherId, voterId).then((result) => {
      setMyRating(result.rated && result.rating !== null ? result.rating : null);
    });
  }, [hasTeacherId, section.id, section.teacherId]);

  const submit = () => {
    if (!hasTeacherId || rating === 0) return;
    const previousRating = myRating;
    applyOptimistic(section.teacherId, rating);
    setMyRating(rating);
    setEditing(false);
    setShowModal(false);
    setSubmitError(null);
    fetch("/api/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: section.id,
        teacherId: section.teacherId,
        rating,
        voterId: getVoterId(),
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return refresh(section.id);
      })
      .catch(() => {
        removeOptimistic(section.id, section.teacherId);
        setMyRating(previousRating);
        setRating(previousRating ?? 0);
        setEditing(true);
        setSubmitError("评分保存失败，请稍后重试");
      });
  };

  const remove = () => {
    if (!hasTeacherId) return;
    const voterId = getVoterId();
    removeOptimistic(section.id, section.teacherId);
    setSubmitError(null);
    setMyRating(null);
    setEditing(false);
    deleteMyRating(section.id, section.teacherId, voterId)
      .then(() => refresh(section.id))
      .catch(() => {});
  };

  const openEditor = () => {
    setSubmitError(null);
    setRating(myRating ?? 0);
    setEditing((v) => !v);
  };

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_minmax(140px,0.55fr)_minmax(260px,0.9fr)] gap-3 md:gap-4 px-4 md:px-5 py-4 border-b border-gray-100 last:border-b-0">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-800 truncate" title={section.name}>
            {section.name}
          </div>
          <div className="mt-1 text-[11px] text-gray-400 tabular-nums">{section.id}</div>
        </div>

        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-700 truncate" title={section.teacher || "未指定"}>
            {section.teacher || "未指定"}
          </div>
          <div className="mt-1 text-[11px] text-gray-400 tabular-nums">
            {section.teacherId ? `教号 ${section.teacherId}` : "无教号"}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StarRating rating={avg?.avg_rating ?? null} count={avg?.count} />
            {hasTeacherId ? (
              <button
                type="button"
                onClick={openEditor}
                className={`h-8 px-3 rounded-lg text-xs font-bold transition-colors ${
                  editing
                    ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    : myRating != null
                    ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                    : "bg-red-50 text-red-700 hover:bg-red-100"
                }`}
              >
                {editing ? "收起" : myRating != null ? "修改评分" : "评分"}
              </button>
            ) : (
              <span className="text-xs text-gray-300">不可评分</span>
            )}
          </div>

          {editing && hasTeacherId && (
            <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50/60 p-3">
              <StarRatingInput value={rating} onChange={setRating} size={22} />
              <div className="mt-3 flex items-center justify-end gap-2">
                {myRating != null && (
                  <button
                    type="button"
                    onClick={remove}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-500 hover:bg-white hover:text-gray-700"
                  >
                    撤销评分
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowModal(true)}
                  disabled={rating === 0}
                  className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-bold hover:bg-red-600 disabled:bg-gray-200 disabled:text-gray-400"
                >
                  提交评分
                </button>
              </div>
              {submitError && (
                <div className="mt-2 text-[12px] font-medium text-rose-600">{submitError}</div>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        open={showModal}
        teacherName={section.teacher}
        rating={rating}
        existingRating={myRating}
        onConfirm={submit}
        onCancel={() => setShowModal(false)}
      />
    </>
  );
}

export function QuickRatingPanel({ sections }: Props) {
  const uniqueSections = useMemo(() => {
    const seen = new Set<string>();
    return sections.filter((s) => {
      const key = sectionKey(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [sections]);

  if (uniqueSections.length === 0) {
    return (
      <div className="px-6 py-20 text-center">
        <div className="text-sm font-semibold text-gray-500">没有可评价的上学期课程</div>
        <div className="mt-1 text-xs text-gray-400">可取消筛选后查看完整课程列表。</div>
      </div>
    );
  }

  return (
    <section aria-label="评价上学期课程" className="bg-white">
      <div className="px-4 md:px-5 py-4 border-b border-gray-100">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-gray-800">评价上学期课程</h2>
            <p className="mt-1 text-xs text-gray-400">仅显示学号导入后匹配到的上学期课程。</p>
          </div>
          <div className="text-xs text-gray-400 tabular-nums">{uniqueSections.length} 个评分入口</div>
        </div>
      </div>
      <div className="hidden md:grid grid-cols-[minmax(0,1.4fr)_minmax(140px,0.55fr)_minmax(260px,0.9fr)] gap-4 px-5 py-3 bg-gray-50 border-b border-gray-100 text-[11px] font-semibold text-gray-500">
        <div>课程名称</div>
        <div>任课教师</div>
        <div>评分入口</div>
      </div>
      <div>
        {uniqueSections.map((s) => (
          <QuickRatingRow key={sectionKey(s)} section={s} />
        ))}
      </div>
    </section>
  );
}
