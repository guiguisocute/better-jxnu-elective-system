// 项目贡献者头像墙：GitHub 头像 + 悬停放大/红环、点击下沉动效 + 跳转主页。
// 头像走 GitHub 的 <login>.png 端点，无需 API。落地首屏与侧栏底部共用。
const CONTRIBUTORS = [
  { login: "guiguisocute", url: "https://github.com/guiguisocute" },
  { login: "xmy3", url: "https://github.com/xmy3" },
];

export function Contributors({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-col items-center gap-2.5 ${className}`}>
      <div className="text-[11px] font-medium tracking-wide text-gray-400">贡献者</div>
      <div className="flex flex-wrap items-start justify-center gap-x-5 gap-y-3">
        {CONTRIBUTORS.map((c) => (
          <a
            key={c.login}
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`@${c.login}`}
            className="group flex w-16 flex-col items-center gap-1.5 transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 active:scale-95"
          >
            <img
              src={`https://github.com/${c.login}.png?size=96`}
              alt={c.login}
              loading="lazy"
              className="h-11 w-11 rounded-full object-cover ring-2 ring-gray-200 shadow-sm transition-all duration-200 ease-out group-hover:scale-110 group-hover:ring-brand group-hover:shadow-md group-active:scale-100"
            />
            <span className="max-w-full truncate text-[11px] text-gray-400 transition-colors group-hover:text-brand">
              @{c.login}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
