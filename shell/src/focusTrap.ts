// 焦点陷阱（UI-05，docs/ui_design_improvement_plan.md）：模态打开期间把 Tab 循环限制在
// 容器内部，关闭时调用返回的 release 函数解除。与 anim.ts 的 showEl/hideEl 配合使用：
// showEl 之后 trapFocus(container)，hideEl 之前 release()。
//
// 支持模态叠加（如设置面板之上再弹 openConfirm 确认框）：内部维护一个陷阱栈，
// 任意时刻只有栈顶（最后打开、z-index 最高）的陷阱响应 Tab，其余静默，避免互相抢焦点。

/** 可聚焦元素选择器（排除禁用/隐藏 input[type=hidden]） */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  'input:not(:disabled):not([type="hidden"])',
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface TrapEntry {
  container: HTMLElement;
  handler: (e: KeyboardEvent) => void;
}

/** 活跃陷阱栈（栈顶 = 当前最上层模态，唯一响应 Tab 的那个） */
const stack: TrapEntry[] = [];
let globalListenerWired = false;

/** 收集容器内当前可见（未被 .hidden / display:none 隐藏）的可聚焦元素 */
function focusablesOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

function onGlobalKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const top = stack[stack.length - 1];
  if (!top) return;
  top.handler(e);
}

function ensureGlobalListener(): void {
  if (globalListenerWired) return;
  globalListenerWired = true;
  // capture 阶段拦截：先于容器内部其它 keydown 处理器（如 dialog.ts 的 Esc 关闭）生效
  document.addEventListener("keydown", onGlobalKeyDown, true);
}

/**
 * 给容器加焦点陷阱；返回解除函数（幂等，可安全多次调用）。
 * 调用方负责在模态隐藏前调用返回值解除陷阱，否则栈会残留失效条目。
 */
export function trapFocus(container: HTMLElement): () => void {
  const handler = (e: KeyboardEvent): void => {
    const focusables = focusablesOf(container);
    if (focusables.length === 0) {
      // 容器内没有可聚焦元素（理论上不该发生，模态至少有确定/取消按钮）：吞掉 Tab 防止焦点逃逸
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const insideContainer = active !== null && container.contains(active);
    if (e.shiftKey) {
      if (!insideContainer || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (!insideContainer || active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  ensureGlobalListener();
  stack.push({ container, handler });

  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const idx = stack.findIndex((t) => t.container === container);
    if (idx !== -1) stack.splice(idx, 1);
  };
}
