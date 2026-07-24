// 匿名身份：boring-avatars (variant="beam") 头像 + wg-random-name 随机中文昵称。
// avatar 字段只存 seed 字符串；颜色由 seed 确定性派生（同一 seed 永远同一张脸同一配色），
// 后端/管理面板不关心渲染细节。昵称每次写评价随机生成一个，不持久化。

import randomName from "wg-random-name";

const AVATAR_KEY = "jxnu_review_avatar";

function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** seed → boring-avatars 的 5 色 palette（确定性「随机」；HSL 保持柔和明快） */
export function seedColors(seed: string | null | undefined): string[] {
  const h = hashSeed(seed || "momo");
  const colors: string[] = [];
  for (let i = 0; i < 5; i++) {
    const hue = (h * (i + 3) * 47) % 360;
    const sat = 55 + ((h >> (i + 2)) % 30); // 55–84%
    const light = 55 + ((h >> (i + 5)) % 25); // 55–79%
    colors.push(`hsl(${hue} ${sat}% ${light}%)`);
  }
  return colors;
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

/** 随机中文匿名昵称（wg-random-name，如「快乐的小猫咪」），失败兜底空串（展示层再兜「匿名同学」） */
export function randomNickname(): string {
  try {
    const name = randomName.getNickName();
    return typeof name === "string" ? name.slice(0, 20) : "";
  } catch {
    return "";
  }
}

export const FALLBACK_NICKNAME = "匿名同学";
