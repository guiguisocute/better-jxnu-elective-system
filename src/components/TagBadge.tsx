import { tagColorClasses } from "../lib/tagColors";

export function TagBadge({ tag }: { tag: string }) {
  return (
    <span className={`inline-flex shrink-0 whitespace-nowrap px-2 py-0.5 rounded-md text-[11px] font-medium border ${tagColorClasses(tag)}`}>
      {tag}
    </span>
  );
}
