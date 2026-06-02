import { useState, useEffect, useRef } from "react";
import { copyText } from "../lib/clipboard";

// 复制课程号小按钮：成功后短暂显示 ✓。clipboard 不可用时（HTTP LAN）由 copyText 兜底 execCommand。
interface Props {
  text: string;
  className?: string;
  title?: string;
}

export function CopyIdButton({ text, className = "", title = "复制课程号" }: Props) {
  const [copied, setCopied] = useState(false);
  // 计时器存 ref 并在卸载时清理 —— 列表里大量复制按钮被快速挂载/卸载时不残留定时器。
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <button
      onClick={handle}
      title={title}
      className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors ${
        copied ? "text-green-500" : "text-gray-400 hover:text-gray-700 hover:bg-gray-100"
      } ${className}`}
    >
      {copied ? (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
      ) : (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
      )}
    </button>
  );
}
