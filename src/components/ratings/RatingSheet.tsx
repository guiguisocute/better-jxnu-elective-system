import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Dimension, ReviewSubmit } from "../../lib/reviewDimensions";
import {
  DIMENSIONS,
  DIMENSION_COLORS,
  DIMENSION_LABELS,
  DIMENSION_STAR_TEXT,
  starTextFor,
} from "../../lib/reviewDimensions";
import { fetchMyReview, submitReview, fetchReviewConfig } from "../../lib/reviewsStore";
import {
  getAvatarSeed,
  setAvatarSeed,
  randomAvatarSeed,
  randomNickname,
} from "../../lib/avatar";
import { AnonAvatar } from "./AnonAvatar";
import { getVoterId } from "../../lib/voter";
import { StarRatingInput } from "../StarRatingInput";
import { useTheme } from "../../hooks/useTheme";

export interface RatingSheetTarget {
  teacherId: string;
  teacherName: string;
  /** 可评的课程（该教师开的课）；多于一门时出现课程选择 */
  courseOptions: { id: string; name: string }[];
  initialCourseId?: string;
}

interface Props {
  target: RatingSheetTarget;
  onClose: () => void;
  /** 提交成功后回调（父层刷新评语流/聚合） */
  onSubmitted?: (courseId: string) => void;
}

type Draft = {
  scores: Partial<Record<Dimension, number>>;
  comments: Partial<Record<Dimension, string>>;
};

const COMMENT_FIELD: Record<Dimension, keyof ReviewSubmit> = {
  overall: "overallC",
  assess: "assessC",
  attendance: "attendanceC",
  difficulty: "difficultyC",
  teaching: "teachingC",
};

// ===== 草稿（localStorage）：误触关闭不丢内容；成功提交后清除 =====
interface StoredDraft extends Draft {
  nickname?: string;
  seed?: string;
}

function draftKey(courseId: string, teacherId: string) {
  return `jxnu.review.draft.${courseId}|${teacherId}`;
}

function loadDraft(courseId: string, teacherId: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(courseId, teacherId));
    if (!raw) return null;
    const d = JSON.parse(raw) as StoredDraft;
    if (!d || typeof d !== "object") return null;
    return { scores: d.scores ?? {}, comments: d.comments ?? {}, nickname: d.nickname, seed: d.seed };
  } catch {
    return null;
  }
}

function draftHasContent(d: Draft) {
  return (
    DIMENSIONS.some((dim) => (d.scores[dim] ?? 0) > 0) ||
    DIMENSIONS.some((dim) => (d.comments[dim] ?? "").trim() !== "")
  );
}

// ===== Cloudflare Turnstile（站点配置了 site key 才启用）=====
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

let turnstileScript: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileScript) {
    turnstileScript = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("turnstile script failed"));
      document.head.appendChild(s);
    });
  }
  return turnstileScript;
}

/** 可搜索课程下拉（React 风格 combobox）：输入过滤 + 点击选择。 */
function CourseCombobox({
  options,
  value,
  onChange,
}: {
  options: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((o) => o.id === value);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.name.toLowerCase().includes(q) || o.id.includes(q))
    : options;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        className="w-full flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-[13px] text-gray-800 bg-white hover:border-red-200 transition-colors"
      >
        <span className="truncate text-left">
          {selected ? (
            <>
              {selected.name}
              <span className="text-gray-400 font-mono text-[11px] ml-1.5">{selected.id}</span>
            </>
          ) : (
            <span className="text-gray-400">选择课程…</span>
          )}
        </span>
        <svg className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-xl bg-white shadow-lg ring-1 ring-gray-100 overflow-hidden">
          <div className="p-2 border-b border-gray-50">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索课程名 / 课程号…"
              className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] bg-gray-50 focus:bg-white outline-none focus:border-red-200"
            />
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center justify-between gap-2 ${
                  o.id === value ? "bg-red-50 text-red-600 font-semibold" : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                <span className="truncate">{o.name}</span>
                <span className="shrink-0 text-[11px] font-mono text-gray-400">{o.id}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-[12px] text-gray-400 text-center">没有匹配的课程</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 匿名写评价面板：头像/昵称 → 5 维度星级（每档实时文案 + 常显可选评语框）→ 匿名发布。
// 每一项都可不填，但至少要给一个维度打分。草稿自动存 localStorage，误关不丢。
export function RatingSheet({ target, onClose, onSubmitted }: Props) {
  const [courseId, setCourseId] = useState(
    target.initialCourseId ?? target.courseOptions[0]?.id ?? ""
  );
  const [seed, setSeed] = useState(getAvatarSeed);
  // 昵称每次打开随机生成一个（wg-random-name 中文昵称）；草稿/已有评价会覆盖
  const [nickname, setNick] = useState(randomNickname);
  const [draft, setDraft] = useState<Draft>({ scores: {}, comments: {} });
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState(false);
  const [pendingDone, setPendingDone] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState(false);

  // Turnstile
  const [tsSiteKey, setTsSiteKey] = useState<string | null>(null); // null = 配置未加载
  const [tsToken, setTsToken] = useState("");
  const tsRef = useRef<HTMLDivElement | null>(null);
  const tsWidgetId = useRef<string | null>(null);
  // 挂件主题跟随站点主题（而非 Turnstile 默认的 auto=跟随系统），与用户在站内选的亮/暗一致
  const { resolved: theme } = useTheme();

  const hasScore = useMemo(
    () => DIMENSIONS.some((d) => (draft.scores[d] ?? 0) > 0),
    [draft.scores]
  );

  // 站点配置：是否启用 Turnstile
  useEffect(() => {
    let cancelled = false;
    fetchReviewConfig().then((cfg) => {
      if (!cancelled) setTsSiteKey(cfg.turnstileSiteKey);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 渲染 Turnstile 挂件
  useEffect(() => {
    if (!tsSiteKey || pendingDone) return;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !tsRef.current || !window.turnstile || tsWidgetId.current) return;
        tsWidgetId.current = window.turnstile.render(tsRef.current, {
          sitekey: tsSiteKey,
          theme, // "light" | "dark"，跟随站点主题
          callback: (token: string) => setTsToken(token),
          "expired-callback": () => setTsToken(""),
          "error-callback": () => setTsToken(""),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (tsWidgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(tsWidgetId.current);
        } catch { /* ignore */ }
        tsWidgetId.current = null;
      }
    };
    // theme 变化时重建挂件以换肤（已取得的 token 仍有效，无需强制重新验证）
  }, [tsSiteKey, pendingDone, theme]);

  // 打开/切课程：草稿优先，其次回填已提交的评价
  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    setLoading(true);
    setExisting(false);
    setRestoredDraft(false);

    const stored = loadDraft(courseId, target.teacherId);
    if (stored && draftHasContent(stored)) {
      setDraft({ scores: stored.scores, comments: stored.comments });
      if (stored.nickname) setNick(stored.nickname);
      if (stored.seed) setSeed(stored.seed);
      setRestoredDraft(true);
    } else {
      setDraft({ scores: {}, comments: {} });
    }

    fetchMyReview(courseId, target.teacherId, getVoterId())
      .then((mine) => {
        if (cancelled || !mine) return;
        setExisting(true);
        if (stored && draftHasContent(stored)) return; // 草稿优先
        const scores: Draft["scores"] = {};
        const comments: Draft["comments"] = {};
        for (const d of DIMENSIONS) {
          const v = mine[d];
          if (typeof v === "number") scores[d] = v;
          const c = mine[`${d}C` as keyof typeof mine];
          if (typeof c === "string" && c) comments[d] = c;
        }
        setDraft({ scores, comments });
        if (mine.nickname) setNick(mine.nickname);
        if (mine.avatar) setSeed(mine.avatar);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
     
  }, [courseId, target.teacherId]);

  // 草稿自动保存（有内容才写；提交成功时清除）
  useEffect(() => {
    if (!courseId || pendingDone) return;
    try {
      if (draftHasContent(draft)) {
        const stored: StoredDraft = { ...draft, nickname, seed };
        localStorage.setItem(draftKey(courseId, target.teacherId), JSON.stringify(stored));
      } else {
        localStorage.removeItem(draftKey(courseId, target.teacherId));
      }
    } catch { /* 存储满等忽略 */ }
  }, [draft, nickname, seed, courseId, target.teacherId, pendingDone]);

  const turnstileRequired = !!tsSiteKey;
  const turnstileBlocking = turnstileRequired && !tsToken;

  const handleSubmit = async () => {
    if (!courseId || !hasScore || submitting || turnstileBlocking) return;
    setSubmitting(true);
    setError("");
    setAvatarSeed(seed);
    const payload: ReviewSubmit = {
      courseId,
      teacherId: target.teacherId,
      voterId: getVoterId(),
      avatar: seed,
      nickname: nickname.trim() || null,
      turnstileToken: turnstileRequired ? tsToken : null,
    };
    for (const d of DIMENSIONS) {
      const score = draft.scores[d];
      payload[d] = score && score > 0 ? score : null;
      const comment = (draft.comments[d] ?? "").trim();
      (payload[COMMENT_FIELD[d]] as string | null) =
        score && score > 0 && comment ? comment.slice(0, 500) : null;
    }
    const res = await submitReview(payload);
    setSubmitting(false);
    if (res.ok) {
      try {
        localStorage.removeItem(draftKey(courseId, target.teacherId));
      } catch { /* ignore */ }
      onSubmitted?.(courseId);
      if (res.pending) {
        setPendingDone(true); // 审核模式：留在面板上告知「待审核」
      } else {
        onClose();
      }
    } else {
      setError("提交失败，请稍后再试（若页面出现人机验证请先完成）");
      setTsToken("");
      if (tsWidgetId.current && window.turnstile) {
        try {
          window.turnstile.reset(tsWidgetId.current);
        } catch { /* ignore */ }
      }
    }
  };

  // Portal 到 body：详情页 aside 等祖先带 transform/sticky 会形成局部堆叠上下文，
  // 直接就地渲染时 fixed 遮罩压不住页面其他 z 层。
  return createPortal(
    // 点击遮罩不再关闭：编写评价时长按拖拽（选文字/拉滑块）松手落在遮罩上会误触 click→关闭，
    // 面板整个消失、体验很差。只允许右上角「×」关闭。
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-6">
      <div className="w-full sm:max-w-lg max-h-[92vh] bg-white rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col">
        {pendingDone ? (
          <div className="px-6 py-10 text-center">
            <div className="text-4xl mb-3" aria-hidden>✅</div>
            <h2 className="text-[15px] font-bold text-gray-900">评价已提交</h2>
            <p className="text-[12px] text-gray-500 mt-2 leading-relaxed">
              当前站点开启了审核模式，你的评价将在管理员审核通过后公开展示。
            </p>
            <button
              onClick={onClose}
              className="mt-5 px-6 py-2.5 rounded-full bg-gradient-to-r from-red-500 to-rose-500 text-white text-[13px] font-bold shadow-md shadow-rose-200/70 hover:from-red-600 hover:to-rose-600"
            >
              知道了
            </button>
          </div>
        ) : (
        <>
        {/* header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-[15px] font-bold text-gray-900">
              {existing ? "修改评价" : "写评价"} · {target.teacherName}
            </h2>
            <p className="text-[11px] text-gray-400 mt-0.5">
              匿名发布 · 每个维度都可以只评你在意的 · 草稿自动保存
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 课程选择（多课程教师）：可搜索下拉 */}
          {target.courseOptions.length > 1 ? (
            <div>
              <label className="text-[11px] font-semibold text-gray-500 block mb-1.5">评价哪门课？</label>
              <CourseCombobox
                options={target.courseOptions}
                value={courseId}
                onChange={setCourseId}
              />
            </div>
          ) : (
            target.courseOptions[0] && (
              <p className="text-[12px] text-gray-500">
                课程：<span className="text-gray-800 font-medium">{target.courseOptions[0].name}</span>
              </p>
            )
          )}

          {restoredDraft && (
            <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
              已恢复上次未发布的草稿
              <button
                onClick={() => {
                  try {
                    localStorage.removeItem(draftKey(courseId, target.teacherId));
                  } catch { /* ignore */ }
                  setDraft({ scores: {}, comments: {} });
                  setRestoredDraft(false);
                }}
                className="ml-2 underline hover:text-amber-800"
              >
                清空重写
              </button>
            </p>
          )}

          {/* 匿名身份 */}
          <div className="flex items-center gap-3 rounded-xl bg-gray-50 px-3.5 py-3">
            <AnonAvatar seed={seed} size={44} />
            <div className="flex-1 min-w-0">
              <input
                value={nickname}
                onChange={(e) => setNick(e.target.value.slice(0, 20))}
                placeholder="匿名同学"
                className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] bg-white"
              />
            </div>
            <button
              onClick={() => {
                setSeed(randomAvatarSeed());
                setNick(randomNickname());
              }}
              className="shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-gray-500 bg-white border border-gray-200 hover:text-red-500 hover:border-red-200 transition-colors"
            >
              换一个
            </button>
          </div>

          {loading && <p className="text-[12px] text-gray-400 text-center">正在读取你之前的评价…</p>}

          {/* 5 维度 */}
          {DIMENSIONS.map((d) => {
            const color = DIMENSION_COLORS[d];
            const score = draft.scores[d] ?? 0;
            return (
              <div key={d} className="rounded-xl ring-1 ring-gray-100 px-3.5 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-gray-800 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color.bar }} aria-hidden />
                    {DIMENSION_LABELS[d]}
                  </span>
                  {score > 0 ? (
                    <button
                      onClick={() =>
                        setDraft((prev) => {
                          const scores = { ...prev.scores };
                          delete scores[d];
                          return { ...prev, scores };
                        })
                      }
                      className="text-[11px] text-gray-400 hover:text-gray-600"
                    >
                      清除
                    </button>
                  ) : (
                    <span className="text-[11px] text-gray-300">不评</span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <StarRatingInput
                    value={score}
                    onChange={(v) => setDraft((prev) => ({ ...prev, scores: { ...prev.scores, [d]: v } }))}
                    size={24}
                  />
                  <span className={`text-[12px] font-semibold ${score > 0 ? color.text : "text-gray-300"}`}>
                    {score > 0 ? starTextFor(d, score) : `1★ ${DIMENSION_STAR_TEXT[d][0]} → 5★ ${DIMENSION_STAR_TEXT[d][4]}`}
                  </span>
                </div>
                {score > 0 && (
                  <textarea
                    value={draft.comments[d] ?? ""}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, comments: { ...prev.comments, [d]: e.target.value.slice(0, 500) } }))
                    }
                    placeholder={`关于${DIMENSION_LABELS[d]}想说的…（可不填）`}
                    rows={2}
                    maxLength={500}
                    className="mt-2 w-full rounded-lg border border-gray-200 px-2.5 py-2 text-[12px] leading-relaxed resize-y"
                  />
                )}
              </div>
            );
          })}

          {/* Turnstile 人机验证（站点开启时出现） */}
          {turnstileRequired && <div ref={tsRef} className="flex justify-center" />}

          {error && <p className="text-[12px] text-red-500 text-center">{error}</p>}
        </div>

        {/* footer */}
        <div className="px-5 py-3.5 border-t border-gray-100 shrink-0 flex items-center gap-3">
          <p className="flex-1 text-[11px] text-gray-400 leading-snug">
            重新提交会覆盖你之前对该老师这门课的评价
          </p>
          <button
            onClick={handleSubmit}
            disabled={!hasScore || !courseId || submitting || turnstileBlocking}
            title={turnstileBlocking ? "请先完成人机验证" : undefined}
            className="shrink-0 px-5 py-2.5 rounded-full bg-gradient-to-r from-red-500 to-rose-500 text-white text-[13px] font-bold shadow-md shadow-rose-200/70 hover:from-red-600 hover:to-rose-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98]"
          >
            {submitting ? "发布中…" : "匿名发布"}
          </button>
        </div>
        </>
        )}
      </div>
    </div>,
    document.body
  );
}
