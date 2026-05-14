import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useCourseData } from "../hooks/useCourseData";
import { useRatings } from "../hooks/useRatings";
import { getVoterId } from "../lib/voter";
import { checkMyRating, deleteMyRating, removeOptimistic } from "../lib/ratingsStore";
import { TagBadge } from "./TagBadge";
import { StarRating } from "./StarRating";
import { StarRatingInput } from "./StarRatingInput";
import { ConfirmModal } from "./ConfirmModal";

export function CourseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { courses, loading, error } = useCourseData();
  const { getAvg, applyOptimistic, refresh } = useRatings(id);
  const [ratingTarget, setRatingTarget] = useState<{ teacherId: string; name: string; rating: number } | null>(null);
  const [showModal, setShowModal] = useState(false);
  // Track which teachers the current user has already rated
  const [myRatings, setMyRatings] = useState<Record<string, number>>({});

  const course = courses.find((c) => c.id === id);

  // On mount/course change, check which teachers the current user has already rated
  useEffect(() => {
    if (!course || !id) return;
    const voterId = getVoterId();
    for (const t of course.teachers) {
      checkMyRating(id, t.id, voterId).then((result) => {
        if (result.rated && result.rating !== null) {
          setMyRatings((prev) => ({ ...prev, [t.id]: result.rating! }));
        }
      });
    }
  }, [id, course]);

  const handleSubmit = () => {
    if (!ratingTarget || !id) return;
    applyOptimistic(ratingTarget.teacherId, ratingTarget.rating);
    // Mark as my rating locally
    setMyRatings((prev) => ({ ...prev, [ratingTarget.teacherId]: ratingTarget.rating }));
    setRatingTarget(null);
    setShowModal(false);
    fetch("/api/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: id,
        teacherId: ratingTarget.teacherId,
        rating: ratingTarget.rating,
        voterId: getVoterId(),
      }),
    }).then(() => refresh(id)).catch(() => {});
  };

  const handleDelete = (teacherId: string) => {
    if (!id) return;
    const voterId = getVoterId();
    // Remove from local state immediately
    removeOptimistic(id, teacherId);
    setMyRatings((prev) => {
      const next = { ...prev };
      delete next[teacherId];
      return next;
    });
    setRatingTarget(null);
    // Send delete request to server
    deleteMyRating(id, teacherId, voterId)
      .then(() => refresh(id))
      .catch(() => {});
  };

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
              {course.teachers.map((t, i) => {
                const avg = getAvg(t.id);
                const isRating = ratingTarget?.teacherId === t.id;
                const hasMyRating = t.id in myRatings;
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
                      <button
                        onClick={() => setRatingTarget(isRating ? null : { teacherId: t.id, name: t.name, rating: hasMyRating ? myRatings[t.id] : 0 })}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors self-center"
                        style={{
                          backgroundColor: isRating ? "#FEE2E2" : hasMyRating ? "#FEF3C7" : "#FEE2E2",
                          color: isRating ? "#DC2626" : hasMyRating ? "#D97706" : "#DC2626",
                        }}
                      >
                        {isRating ? "收起" : hasMyRating ? "修改评分" : "评分"}
                      </button>
                    </div>
                    <div className="flex items-center mt-2 pl-[52px]">
                      <StarRating rating={avg?.avg_rating ?? null} count={avg?.count} />
                    </div>
                    {isRating && (
                      <div className="mt-3 pl-[52px]">
                        <StarRatingInput
                          value={ratingTarget.rating}
                          onChange={(v) => setRatingTarget({ ...ratingTarget, rating: v })}
                        />
                        <div className="flex gap-2 mt-2.5">
                          <button
                            onClick={() => setRatingTarget(null)}
                            className="flex-1 py-2 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-gray-50"
                          >
                            取消
                          </button>
                          {hasMyRating && (
                            <button
                              onClick={() => handleDelete(t.id)}
                              className="flex-1 py-2 rounded-lg border border-red-200 text-xs text-red-500 font-medium hover:bg-red-50 transition-colors"
                            >
                              撤销评分
                            </button>
                          )}
                          <button
                            onClick={() => ratingTarget.rating > 0 && setShowModal(true)}
                            disabled={ratingTarget.rating === 0}
                            className="flex-1 py-2 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
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
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="text-center text-gray-400 py-10 text-sm">暂无教师信息</div>
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
          className="block w-full py-3 rounded-xl bg-red-500 text-white text-sm font-medium text-center hover:bg-red-600 active:bg-red-700 transition-colors shadow-sm"
        >
          点击跳转此课程选课界面
        </a>
      </main>

      <ConfirmModal
        open={showModal}
        teacherName={ratingTarget?.name ?? ""}
        rating={ratingTarget?.rating ?? 0}
        existingRating={ratingTarget ? (myRatings[ratingTarget.teacherId] ?? null) : null}
        onConfirm={handleSubmit}
        onCancel={() => setShowModal(false)}
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
