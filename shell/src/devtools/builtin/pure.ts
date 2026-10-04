// 内置工具的纯函数库（PR-3）：编解码 / 哈希 / 时间戳 / UUID。
// 全部零 DOM 依赖，单测覆盖（__tests__/pure.test.ts）。

import { t } from "../../i18n";
// ---------- Base64 ----------

/** UTF-8 安全的 Base64 编码（TextEncoder + btoa） */
export function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

/** Base64 解码（UTF-8 安全；非法输入抛 Error） */
export function base64Decode(b64: string): string {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// ---------- URL 编码 ----------

export function urlEncode(text: string): string {
  return encodeURIComponent(text);
}

export function urlDecode(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, "%20"));
}

// ---------- 哈希（纯 JS 实现，零依赖） ----------

/** md5(input) → 小写 hex。实现：RFC 1321（标准四轮变换）。 */
export function md5Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  // 初始化
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  // 填充：0x80 + 0* + 8 字节小端位长
  const bitLen = msg.length * 8;
  const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) * 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

  const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));

  for (let off = 0; off < padded.length; off += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setInt32(0, a0, true); out.setInt32(4, b0, true); out.setInt32(8, c0, true); out.setInt32(12, d0, true);
  const hex = (n: number, pad = 8): string => (n >>> 0).toString(16).padStart(pad, "0");
  // 逐字节小端转 hex
  let s = "";
  for (let i = 0; i < 16; i++) s += hex(out.getUint8(i), 2);
  return s;
}

/** sha256(input) → 小写 hex（Web Crypto 异步）。 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- 时间戳 ----------

/** 秒/毫秒时间戳自动识别 → 本地可读时间（含星期）；非法返回 null */
export function timestampToReadable(raw: string): string | null {
  const s = raw.trim();
  if (!/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  // 10 位 = 秒；13 位 = 毫秒；其他位数按数量级猜（1e12 附近 = ms）
  const ms = s.length === 10 ? n * 1000 : s.length === 13 ? n : n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (x: number): string => String(x).padStart(2, "0");
  const week = [t("devtools.pure.wdSun"), t("devtools.pure.wdMon"), t("devtools.pure.wdTue"), t("devtools.pure.wdWed"), t("devtools.pure.wdThu"), t("devtools.pure.wdFri"), t("devtools.pure.wdSat")][d.getDay()];
  return t("devtools.pure.readable", { y: d.getFullYear(), mo: pad(d.getMonth() + 1), d: pad(d.getDate()), h: pad(d.getHours()), mi: pad(d.getMinutes()), s: pad(d.getSeconds()), w: week });
}

/** 当前时间的秒级时间戳 */
export function nowUnixSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

// ---------- UUID ----------

/** 生成 v4 UUID（crypto.randomUUID 优先，回退 Math.random 实现） */
export function uuidV4(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // 回退：RFC 4122 v4（16 字节随机 + 版本/变体位）
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
