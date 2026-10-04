// 动效系统（D3 P-06）：模态等浮层显隐统一入口。
// 入场动画由 CSS 驱动（:not(.hidden) 选择器自动重放）；模态经 hideEl 两阶段隐藏：
// 先播 ~100ms 出场动画再 display:none。html[data-reduce-motion]（设置项「减少动画」）
// 或系统 prefers-reduced-motion 将 CSS 变量 --motion 置 0，全部动效降级为即时。

/** 待执行的延迟隐藏定时器（防 开-关-开 竞态） */
const pendingHide = new WeakMap<HTMLElement, number>();

/** 动效是否被禁用（设置「减少动画」或系统偏好） */
export function motionDisabled(): boolean {
  return (
    document.documentElement.hasAttribute("data-reduce-motion") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 显示元素（取消进行中的延迟隐藏） */
export function showEl(el: HTMLElement): void {
  const t = pendingHide.get(el);
  if (t !== undefined) {
    window.clearTimeout(t);
    pendingHide.delete(el);
  }
  el.classList.remove("closing");
  el.classList.remove("hidden");
}

/** 隐藏元素：模态（.modal）两阶段（先播出场动画），其余即时隐藏 */
export function hideEl(el: HTMLElement): void {
  if (el.classList.contains("hidden") || pendingHide.has(el)) return;
  if (!el.classList.contains("modal") || motionDisabled()) {
    el.classList.add("hidden");
    return;
  }
  el.classList.add("closing");
  const t = window.setTimeout(() => {
    pendingHide.delete(el);
    el.classList.remove("closing");
    el.classList.add("hidden");
  }, 100);
  pendingHide.set(el, t);
}

// ---------- 「减少动画」开关（localStorage 持久化，同 D2 布局尺寸的存储策略） ----------

const REDUCE_MOTION_KEY = "pylume.reduce_motion";

export function reduceMotionEnabled(): boolean {
  return localStorage.getItem(REDUCE_MOTION_KEY) === "1";
}

/** 应用并持久化「减少动画」开关（html[data-reduce-motion] 为 CSS 钩子） */
export function applyReduceMotion(on: boolean): void {
  localStorage.setItem(REDUCE_MOTION_KEY, on ? "1" : "0");
  document.documentElement.toggleAttribute("data-reduce-motion", on);
}

/** 启动时恢复已存的「减少动画」设置 */
export function restoreReduceMotion(): void {
  applyReduceMotion(reduceMotionEnabled());
}
