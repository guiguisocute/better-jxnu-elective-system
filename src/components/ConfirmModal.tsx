interface Props {
  open: boolean;
  teacherName: string;
  rating: number;
  existingRating: number | null;
  onConfirm: () => void;
  onCancel: () => void;
  submitting?: boolean;
}

export function ConfirmModal({ open, teacherName, rating, existingRating, onConfirm, onCancel, submitting }: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />
      <div
        className="relative bg-white rounded-2xl shadow-xl w-[340px] max-w-[90vw] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-gray-900 text-center">
          {existingRating !== null ? "修改评分" : "确认评分"}
        </h3>
        <div className="mt-4 text-center">
          <p className="text-sm text-gray-500">
            为 <span className="font-medium text-gray-800">{teacherName}</span> 评分
          </p>
          <div className="flex items-center justify-center gap-1 mt-2">
            {[1, 2, 3, 4, 5].map((star) => {
              const isFull = rating >= star;
              const isHalf = !isFull && rating >= star - 0.5;
              return (
                <svg key={star} width={28} height={28} viewBox="0 0 20 20">
                  <defs>
                    <linearGradient id={`confirm-half-${star}`}>
                      <stop offset="50%" stopColor="#FBBF24" />
                      <stop offset="50%" stopColor="#E5E7EB" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M10 15.27L16.18 19l-1.64-7.03L20 7.24l-7.19-.61L10 0 7.19 6.63 0 7.24l5.46 4.73L3.82 19z"
                    fill={
                      isFull
                        ? "#FBBF24"
                        : isHalf
                        ? `url(#confirm-half-${star})`
                        : "#E5E7EB"
                    }
                  />
                </svg>
              );
            })}
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-1">{rating.toFixed(1)}</p>
          {existingRating !== null && (
            <p className="text-xs text-gray-400 mt-1">原评分: {existingRating.toFixed(1)}</p>
          )}
        </div>
        {/* Disclaimer */}
        <p className="text-[10px] text-red-300 text-center mt-3 leading-relaxed">
          以上评分均为用户主观评价，仅反映其对任课教师在本课程中表现的个人看法，不代表作者立场，仅供参考
        </p>
        <div className="flex gap-3 mt-3">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-xl bg-red-500 text-white text-sm font-medium hover:bg-red-600 active:bg-red-700 transition-colors disabled:opacity-50"
          >
            {submitting ? "提交中..." : "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
