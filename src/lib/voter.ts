const VOTER_KEY = "jxnu_voter_id";

/**
 * 生成 RFC4122 v4 UUID。
 * 优先用 crypto.randomUUID()（仅在安全上下文/localhost 可用），
 * 否则降级到 crypto.getRandomValues，再退到 Math.random（最后兜底）。
 * 这样 HTTP 局域网（如 dev server 通过 IP 访问）也能正常工作。
 */
function uuidV4(): string {
  const c = (typeof crypto !== "undefined" ? crypto : undefined) as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") + "-" +
    hex.slice(4, 6).join("") + "-" +
    hex.slice(6, 8).join("") + "-" +
    hex.slice(8, 10).join("") + "-" +
    hex.slice(10, 16).join("")
  );
}

export function getVoterId(): string {
  let id = localStorage.getItem(VOTER_KEY);
  if (!id) {
    id = uuidV4();
    localStorage.setItem(VOTER_KEY, id);
  }
  return id;
}
