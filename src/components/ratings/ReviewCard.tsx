import { useRef, useState, type ReactNode } from "react";
import type { Dimension, ReviewRow } from "../../lib/reviewDimensions";
import {
  DIMENSION_COLORS,
  DIMENSION_LABELS,
  DIMENSION_SHORT,
  NEW_DIMENSIONS,
  starTextFor,
} from "../../lib/reviewDimensions";
import { FALLBACK_NICKNAME } from "../../lib/avatar";
import { reportReview } from "../../lib/reviewsStore";
import { getVoterId } from "../../lib/voter";
import { AnonAvatar } from "./AnonAvatar";
import { StarRating } from "../StarRating";
import { HumanVerificationWidget, type HumanVerificationHandle } from "../HumanVerificationWidget";

interface Props {
  row: ReviewRow;
  /** 评价对应的课程名（按老师视图里区分课程用；无则不显示）。广场里是带底框的富文本，故用 ReactNode */
  courseLabel?: ReactNode;
  /** 「有用」数最高的卡片标热评 */
  hot?: boolean;
  onToggleHelpful?: (reviewId: number) => void;
  /** 点击「修改」回调（仅 mine 的卡片出现） */
  onEditMine?: () => void;
}

function timeAgo(iso: string): string {
  // D1 datetime('now') 是 UTC 的 "YYYY-MM-DD HH:MM:SS"
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}天前`;
  if (day < 30) return `${Math.floor(day / 7)}周前`;
  if (day < 365) return `${Math.floor(day / 30)}个月前`;
  return `${Math.floor(day / 365)}年前`;
}

const COMMENT_KEYS: Record<Dimension, keyof ReviewRow> = {
  overall: "overallC",
  assess: "assessC",
  attendance: "attendanceC",
  difficulty: "difficultyC",
  teaching: "teachingC",
};

// 设计稿评价卡：头像+昵称+时间·课程 → 总体星级+文案 → 总体评语 →
// 4 新维度小胶囊 → 分维度评语块（彩色左边框）→ 有用/修改 footer。
export function ReviewCard({ row, courseLabel, hot, onToggleHelpful, onEditMine }: Props) {
  const chips = NEW_DIMENSIONS.filter((d) => row[d] != null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reported, setReported] = useState(false);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportError, setReportError] = useState("");
  const [reportCaptchaToken, setReportCaptchaToken] = useState("");
  const [reportCaptchaRequired, setReportCaptchaRequired] = useState(false);
  const [reportCaptchaReady, setReportCaptchaReady] = useState(false);
  const reportCaptchaRef = useRef<HumanVerificationHandle | null>(null);
  const reportCaptchaBlocking =
    !reportCaptchaReady || (reportCaptchaRequired && !reportCaptchaToken);

  const submitReport = async () => {
    if (reportSubmitting || reportCaptchaBlocking) return;
    setReportSubmitting(true);
    setReportError("");
    const result = await reportReview(
      row.id,
      getVoterId(),
      reportReason,
      reportCaptchaRequired ? reportCaptchaToken : "",
    );
    setReportSubmitting(false);
    if (result === "ok") {
      setReported(true);
      setReportOpen(false);
      return;
    }
    setReportError(
      result === "verification"
        ? "人机验证失败或已过期，请重新验证后再提交。"
        : "举报提交失败，请稍后再试。",
    );
    reportCaptchaRef.current?.reset();
  };
  const dimComments = NEW_DIMENSIONS.filter((d) => {
    const c = row[COMMENT_KEYS[d]];
    return typeof c === "string" && c.length > 0;
  });

  return (
    <div
      className={`rounded-2xl bg-white p-4 shadow-sm transition-shadow hover:shadow-md ${
        hot ? "ring-1 ring-red-200 border-t-2 border-red-400" : "ring-1 ring-gray-100"
      }`}
    >
      {/* 头像 + 昵称 + 时间 */}
      <div className="flex items-center gap-3">
        <AnonAvatar seed={row.avatar} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-gray-800 truncate">
              {row.nickname || FALLBACK_NICKNAME}
            </span>
            {row.mine && (
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px] font-semibold">
                我
              </span>
            )}
            {hot && (
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-red-50 text-red-500 text-[10px] font-semibold">
                热评
              </span>
            )}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5 leading-relaxed break-words [overflow-wrap:anywhere]">
            {timeAgo(row.updatedAt)}
            {courseLabel && <span> · {courseLabel}</span>}
          </div>
        </div>
      </div>

      {/* 总体评分行 */}
      {row.overall != null && (
        <div className="flex items-center gap-2 mt-2.5">
          <StarRating rating={row.overall} />
          <span className="text-sm font-bold text-gray-800 tabular-nums">{row.overall.toFixed(1)}</span>
          <span className="text-xs font-semibold text-red-500">{starTextFor("overall", row.overall)}</span>
        </div>
      )}

      {/* 总体评语（自由文本） */}
      {row.overallC && (
        <p className="text-[13px] text-gray-700 leading-relaxed mt-2 whitespace-pre-line break-words [overflow-wrap:anywhere]">{row.overallC}</p>
      )}

      {/* 4 新维度胶囊 */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {chips.map((d) => {
            const c = DIMENSION_COLORS[d];
            return (
              <span
                key={d}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${c.chipBg} ${c.chipText}`}
                title={`${DIMENSION_LABELS[d]}：${starTextFor(d, row[d] as number)}`}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c.bar }} aria-hidden />
                {DIMENSION_SHORT[d]} {(row[d] as number).toFixed(1)}
              </span>
            );
          })}
        </div>
      )}

      {/* 分维度评语块 */}
      {dimComments.length > 0 && (
        <div className="space-y-2 mt-2.5">
          {dimComments.map((d) => {
            const c = DIMENSION_COLORS[d];
            return (
              <div
                key={d}
                className="rounded-lg bg-gray-50 px-3 py-2"
                style={{ borderLeft: `3px solid ${c.bar}` }}
              >
                <div className={`text-[10px] font-bold mb-0.5 ${c.chipText}`}>{DIMENSION_LABELS[d]}</div>
                <p className="text-[12px] text-gray-700 leading-relaxed whitespace-pre-line break-words [overflow-wrap:anywhere]">
                  {row[COMMENT_KEYS[d]] as string}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* footer：有用 / 修改 / 举报 */}
      <div className="flex items-center gap-4 mt-3 pt-2.5 border-t border-gray-100">
        <button
          onClick={() => onToggleHelpful?.(row.id)}
          className={`inline-flex items-center gap-1.5 text-xs transition-colors ${
            row.myVote ? "text-red-500 font-semibold" : "text-gray-400 hover:text-gray-600"
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={row.myVote ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
          </svg>
          有用{row.helpful > 0 && <span className="tabular-nums">{row.helpful}</span>}
        </button>
        {row.mine && onEditMine && (
          <button
            onClick={onEditMine}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors"
          >
            修改我的评价
          </button>
        )}
        {!row.mine && (
          <button
            onClick={() => {
              if (reported) return;
              setReportError("");
              setReportCaptchaToken("");
              setReportCaptchaReady(false);
              setReportOpen(!reportOpen);
            }}
            className={`ml-auto text-[11px] transition-colors ${
              reported ? "text-gray-300 cursor-default" : "text-gray-300 hover:text-rose-500"
            }`}
          >
            {reported ? "已举报" : "举报"}
          </button>
        )}
      </div>
      {reportOpen && !reported && (
        <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50/40 p-3">
          <textarea
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value.slice(0, 200))}
            placeholder="举报理由（可不填）"
            rows={3}
            maxLength={200}
            className="w-full min-h-[72px] max-h-48 resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-rose-300"
          />
          <div className="mt-1 text-right text-[10px] tabular-nums text-gray-400">
            {reportReason.length}/200
          </div>
          <HumanVerificationWidget
            ref={reportCaptchaRef}
            feature="reports"
            onToken={setReportCaptchaToken}
            onStateChange={(state) => {
              setReportCaptchaRequired(state.required);
              setReportCaptchaReady(state.ready);
            }}
            className="mt-2"
          />
          {reportError && (
            <p className="mt-2 text-[11px] leading-relaxed text-rose-600">{reportError}</p>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReportCaptchaToken("");
                setReportCaptchaReady(false);
                setReportOpen(false);
              }}
              className="px-3 py-1.5 text-[11px] font-medium text-gray-400 hover:text-gray-600"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void submitReport()}
              disabled={reportSubmitting || reportCaptchaBlocking}
              title={reportCaptchaBlocking ? "请先完成人机验证" : undefined}
              className="shrink-0 rounded-lg bg-rose-100 px-3 py-1.5 text-[11px] font-semibold text-rose-600 transition-colors hover:bg-rose-200 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {reportSubmitting ? "提交中…" : "提交举报"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
