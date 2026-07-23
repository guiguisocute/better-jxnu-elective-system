import type { DataSource } from "../types";

interface Props {
  value: DataSource;
  onChange: (v: DataSource) => void;
}

const OPTIONS: { value: DataSource; label: string }[] = [
  { value: "pre", label: "预选" },
  { value: "formal", label: "正选/补退选" },
];

export function DataSourceSwitcher({ value, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="数据来源"
      className="inline-flex items-center rounded-lg border border-gray-200 bg-gray-50/60 p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`min-w-[58px] px-3 py-1 text-xs font-medium rounded-md transition-all ${
              active
                ? "bg-red-500 text-white shadow-sm shadow-red-200"
                : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
