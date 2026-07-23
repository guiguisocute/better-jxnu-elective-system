// 匿名头像（momo 风）：动物 emoji + 柔和底色，由 seed 确定性渲染。
// momo 原图是小红书版权素材，无正规开源包 —— 用本地 emoji 集模拟同款氛围；
// avatar 字段只存 seed 字符串，后端/管理面板不关心渲染细节，
// 日后若拿到可用图包，把 renderAvatar 换成图片映射即可无缝迁移。

const AVATAR_KEY = "jxnu_review_avatar";
const NICKNAME_KEY = "jxnu_review_nickname";

const EMOJIS = [
  "🐢", "🐨", "🐰", "🐵", "🦊", "🐼", "🐧", "🦉",
  "🐙", "🦆", "🐸", "🐹", "🦝", "🐱", "🐶", "🦁",
  "🐷", "🐮", "🦄", "🐳", "🦥", "🦜", "🐿️", "🦔",
];

const BG_COLORS = [
  "#FEE2E2", "#FFEDD5", "#FEF3C7", "#ECFCCB", "#D1FAE5", "#CFFAFE",
  "#DBEAFE", "#E0E7FF", "#EDE9FE", "#FCE7F3", "#F3F4F6", "#FFE4E6",
];

function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

export interface AvatarView {
  emoji: string;
  bg: string;
}

/** seed → 确定性头像（空/缺省 seed 也给一个稳定的兜底样子） */
export function renderAvatar(seed: string | null | undefined): AvatarView {
  const h = hashSeed(seed || "momo");
  return {
    emoji: EMOJIS[h % EMOJIS.length],
    bg: BG_COLORS[Math.floor(h / EMOJIS.length) % BG_COLORS.length],
  };
}

export function randomAvatarSeed(): string {
  const raw = new Uint8Array(6);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(raw);
  } else {
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getAvatarSeed(): string {
  let seed = localStorage.getItem(AVATAR_KEY);
  if (!seed) {
    seed = randomAvatarSeed();
    localStorage.setItem(AVATAR_KEY, seed);
  }
  return seed;
}

export function setAvatarSeed(seed: string) {
  localStorage.setItem(AVATAR_KEY, seed);
}

export function getNickname(): string {
  return localStorage.getItem(NICKNAME_KEY) ?? "";
}

export function setNickname(name: string) {
  const t = name.trim().slice(0, 20);
  if (t) localStorage.setItem(NICKNAME_KEY, t);
  else localStorage.removeItem(NICKNAME_KEY);
}

export const FALLBACK_NICKNAME = "匿名同学";
