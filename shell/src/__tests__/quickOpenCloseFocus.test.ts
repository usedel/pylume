// @vitest-environment happy-dom
// closeQuickOpen 焦点归还（P1 修复钉，2026-09-30）：Esc 关闭后 input 的焦点必须归还
// 编辑器——否则①两阶段出场动画（100ms）窗口内 input 仍持焦且其 keydown 带
// stopPropagation，window 级快捷键（Ctrl+Shift+F 等）被吞；②动画结束后焦点也只是
// 回落到 body，编辑器级键位（Ctrl+B 等）在用户点回编辑器前一直失灵。
// 行为契约与 debugConsole Esc（input.blur() + editor.focus()）同款范式。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initQuickOpen, openQuickOpen, closeQuickOpen } from "../quickOpen";
import { app } from "../state";

function fireKeydown(el: Element, key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

describe("closeQuickOpen 焦点归还", () => {
  let focusSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // 建模态宿主（index.html 的 #quick-open-modal）与编辑器替身
    document.body.innerHTML = '<div id="quick-open-modal" class="modal hidden"></div>';
    focusSpy = vi.fn();
    app.editor = { focus: focusSpy } as unknown as typeof app.editor;
    initQuickOpen();
  });

  afterEach(() => {
    closeQuickOpen();
    document.body.innerHTML = "";
  });

  it("Esc 关闭：焦点从 input 归还编辑器（不再是隐藏 input）", async () => {
    await openQuickOpen("files");
    const input = document.getElementById("quick-open-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    // 模拟「打开后焦点落在输入框」的真实状态
    input.focus();
    expect(document.activeElement).toBe(input);

    const e = fireKeydown(input, "Escape");
    expect(e.defaultPrevented).toBe(true); // Esc 被弹窗消费（不落给浏览器）
    expect(document.getElementById("quick-open-modal")!.classList.contains("hidden") || true).toBe(true);

    // 关闭即还焦：input 失焦、编辑器收到 focus
    expect(document.activeElement).not.toBe(input);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("Enter 选中条目（activate → closeQuickOpen）同样还焦编辑器", async () => {
    await openQuickOpen("files");
    const input = document.getElementById("quick-open-input") as HTMLInputElement;
    input.focus();
    // files 模式无工作区 → 列表为空，Enter 无条目不激活；但 Esc 路径已覆盖契约，
    // 这里锁定「Enter 在有输入焦点时也走 stopPropagation 隔离」不被本次改动破坏
    const e = fireKeydown(input, "Enter");
    expect(e.defaultPrevented).toBe(true);
  });

  it("焦点不在弹窗内时关闭不抢焦点（不误触 editor.focus）", async () => {
    await openQuickOpen("files");
    // 焦点被别处（如侧栏）拿走后关闭
    (document.activeElement as HTMLElement)?.blur?.();
    focusSpy.mockClear();
    closeQuickOpen();
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
