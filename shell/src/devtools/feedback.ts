// 按钮即时反馈：按真实执行结果给出成功态（对勾）或失败态（错误），短暂显示后自动还原。
// 反馈的本质是「告知用户做了什么 / 出了什么问题」，因此调用方必须先拿到结果再决定种类。

import { codicon } from "../util";

const FLASH_MS = 1200;
const originals = new WeakMap<HTMLButtonElement, string>();
const timers = new WeakMap<HTMLButtonElement, number>();

type FlashKind = "ok" | "error";

function flash(btn: HTMLButtonElement, text: string, kind: FlashKind): void {
  const prevTimer = timers.get(btn);
  if (prevTimer !== undefined) window.clearTimeout(prevTimer);

  // 只在首次记录原始内容，避免嵌套 flash 时丢失原始文案
  if (!originals.has(btn)) {
    originals.set(btn, btn.innerHTML);
  }

  const icon = codicon(kind === "ok" ? "check" : "error");
  btn.innerHTML = "";
  btn.appendChild(icon);
  btn.append(` ${text}`);
  btn.classList.add(kind === "ok" ? "flash-ok" : "flash-error");

  const t = window.setTimeout(() => {
    const orig = originals.get(btn);
    if (orig !== undefined) btn.innerHTML = orig;
    originals.delete(btn);
    btn.classList.remove("flash-ok", "flash-error");
    timers.delete(btn);
  }, FLASH_MS);
  timers.set(btn, t);
}

/** 成功反馈（绿色 + 对勾） */
export function flashSuccess(btn: HTMLButtonElement, text: string): void {
  flash(btn, text, "ok");
}

/** 失败反馈（红色 + 感叹号） */
export function flashError(btn: HTMLButtonElement, text: string): void {
  flash(btn, text, "error");
}