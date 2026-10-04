// 全局轻量 toast 通知（UX 审查 P0-1）：异步操作失败/结果的用户可见反馈渠道。
// 此前大量 catch 分支只 console.warn/error，用户完全无感知（静默失败）。
//
// 与 dialog.ts 的分工：需要用户决策或必须确认的信息走 openConfirm / openAlert；
// toast 只做「失败了但不必打断流程」的反馈——右下角堆叠、自动消失、可手动关闭。
// 动效遵循「减少动画」（anim.ts::motionDisabled）；样式见 style.css 的 toast 段。

import { motionDisabled } from "./anim";
import { codicon, errMsg } from "./util";
import { t } from "./i18n";
import { localizeBackendError } from "./i18n/backendError";

export type ToastKind = "info" | "success" | "error";

/** 各级别自动消失时长（error 更长，给用户读完整原因的时间） */
const DURATION: Record<ToastKind, number> = { info: 4000, success: 3000, error: 8000 };
/** 同屏上限：最旧的先移除，防连续失败刷屏 */
const MAX_VISIBLE = 5;
/** 与 style.css 的 .toast.closing 出场动画时长一致 */
const EXIT_MS = 100;

const ICON: Record<ToastKind, string> = { info: "info", success: "check", error: "error" };

/** 可选动作按钮（dep plan §5.5/§6.2：如 envDrift toast 的「查看」→ 打开健康面板）。
 *  点击后立即收起 toast 并执行回调——动作入口不该在自动消失后还占着屏幕。 */
export interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
}

let stackEl: HTMLElement | null = null;

function stack(): HTMLElement {
  // 容器可能被外部移除（如测试的 afterEach 清理）：断开引用时重建，避免往游离节点里追加
  if (!stackEl || !stackEl.isConnected) {
    stackEl = document.getElementById("toast-stack") ?? document.createElement("div");
    if (!stackEl.id) stackEl.id = "toast-stack";
    stackEl.setAttribute("aria-live", "polite");
    document.body.appendChild(stackEl);
  }
  return stackEl;
}

/** 弹出一条通知（不阻塞、自动消失：error 8s / info 4s / success 3s；悬停暂停倒计时）。
 *  opts.actionLabel 提供时追加动作按钮（点击即收起并执行回调）。 */
export function toast(message: string, kind: ToastKind = "info", opts: ToastOptions = {}): void {
  const root = stack();
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  if (kind === "error") el.setAttribute("role", "alert");

  el.appendChild(codicon(ICON[kind]));
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  el.appendChild(text);

  let timer = 0;
  const dismiss = (): void => {
    window.clearTimeout(timer);
    if (!el.isConnected) return;
    if (motionDisabled()) {
      el.remove();
      return;
    }
    el.classList.add("closing");
    window.setTimeout(() => el.remove(), EXIT_MS);
  };

  if (opts.actionLabel) {
    const act = document.createElement("button");
    act.className = "toast-action";
    act.textContent = opts.actionLabel;
    act.addEventListener("click", () => {
      dismiss();
      opts.onAction?.();
    });
    el.appendChild(act);
  }

  const close = document.createElement("button");
  close.className = "toast-close";
  close.setAttribute("aria-label", t("common.closeNotification"));
  close.appendChild(codicon("close"));
  close.addEventListener("click", dismiss);
  el.appendChild(close);

  // 悬停暂停自动消失（读长错误信息时不被打断；移开后 1.5s 再收）
  el.addEventListener("mouseenter", () => window.clearTimeout(timer));
  el.addEventListener("mouseleave", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(dismiss, 1500);
  });

  root.appendChild(el);
  while (root.children.length > MAX_VISIBLE) root.firstElementChild?.remove();
  timer = window.setTimeout(dismiss, DURATION[kind]);
}

/** 失败 toast 的统一文案组装：`${action}失败：${原因}`（catch 分支统一走这里）。
 *  语序随语言变（英文是 "X failed: reason"），故整句交给语言包，不在代码里拼 `失败` 二字。 */
export function toastFail(action: string, e: unknown): void {
  // 后端错误消息（Rust 侧 `Err("中文…")`）在此统一过一道翻译层：英文界面下不会冒出中文错误。
  // 详见 i18n/backendError.ts 头注（模板匹配 + 参数回填，非语言包词条）。
  toast(t("toast.failSuffix", { action, reason: localizeBackendError(errMsg(e)) }), "error");
}
