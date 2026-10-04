// 浏览器加速器护栏的纯逻辑单测（不依赖 DOM：DOM 用例在本机 vitest 环境暂不可用）。
import { describe, expect, it } from "vitest";
import { isBlockedCombo, isClaimedInMonaco, shouldSwallowGuardEvent } from "../browserKeys";

describe("isBlockedCombo", () => {
  it("危险组合：Monaco 内外一律拦（重载 / 打印 / 关窗口 / 清数据 / 插入符浏览 / 浏览器前进后退）", () => {
    const danger = [
      "Ctrl+KeyR", "Ctrl+F5", "Ctrl+KeyP", "Ctrl+KeyO", "Ctrl+KeyU",
      "Ctrl+KeyN", "Ctrl+KeyT", "Ctrl+KeyW", "Ctrl+Shift+KeyW",
      "Ctrl+Shift+Delete", "F7", "Alt+ArrowLeft", "Alt+ArrowRight",
    ];
    for (const c of danger) {
      expect(isBlockedCombo(c, true), `${c} @monaco`).toBe(true);
      expect(isBlockedCombo(c, false), `${c} @outside`).toBe(true);
    }
  });

  it("Monaco 内不误伤自带键位；同样的键在编辑器外归浏览器 → 拦", () => {
    for (const c of ["Ctrl+KeyD", "Ctrl+KeyH", "Ctrl+KeyJ", "Ctrl+KeyK", "F3", "Shift+F3", "F12"]) {
      expect(isBlockedCombo(c, true), `${c} @monaco`).toBe(false);
    }
    for (const c of ["Ctrl+KeyD", "Ctrl+KeyH", "Ctrl+KeyJ", "Ctrl+KeyL", "F3", "Shift+F3", "F12"]) {
      expect(isBlockedCombo(c, false), `${c} @outside`).toBe(true);
    }
  });

  it("应用已认领的组合不吞（动作照旧，只在输入框内补 preventDefault）", () => {
    for (const c of ["F5", "Ctrl+Shift+KeyR", "Ctrl+Shift+KeyP", "Ctrl+KeyS", "Ctrl+KeyG", "Ctrl+Shift+KeyF", "Ctrl+KeyA"]) {
      expect(isBlockedCombo(c, false), `${c} @outside`).toBe(false);
      expect(isBlockedCombo(c, true), `${c} @monaco`).toBe(false);
    }
  });
});

describe("isClaimedInMonaco（P1：智能选区 Ctrl+W 的放行口径）", () => {
  it("Ctrl+W / Ctrl+Shift+W 在编辑器内放行给 Monaco（仍由 isBlockedCombo 负责 preventDefault）", () => {
    for (const c of ["Ctrl+KeyW", "Ctrl+Shift+KeyW"]) {
      expect(isClaimedInMonaco(c, true)).toBe(true);
      expect(isClaimedInMonaco(c, false)).toBe(false); // 编辑器外仍彻底吞掉（防关窗口）
      expect(isBlockedCombo(c, true)).toBe(true); // 放行 ≠ 不拦：浏览器动作仍被 preventDefault
      expect(isBlockedCombo(c, false)).toBe(true);
    }
  });

  it("其余危险键不放行（仍 stopPropagation，避免 Monaco 未认领时落浏览器）", () => {
    for (const c of ["Ctrl+KeyR", "Ctrl+KeyP", "Ctrl+KeyN", "Ctrl+KeyT", "Ctrl+Shift+Delete", "F7"]) {
      expect(isClaimedInMonaco(c, true)).toBe(false);
    }
  });
});

describe("shouldSwallowGuardEvent（吞事件决策：录入放行 / window 级认领放行）", () => {
  it("键位录入中：危险键也不吞（事件送进录入框成键，浏览器动作仍由 preventDefault 阻断）", () => {
    for (const c of ["Ctrl+KeyW", "Ctrl+KeyT", "Ctrl+KeyN", "Ctrl+KeyR", "Ctrl+Shift+Delete"]) {
      expect(shouldSwallowGuardEvent(c, false, true, false), `${c} @capture`).toBe(false);
      expect(isBlockedCombo(c, false), `${c} 仍属危险键`).toBe(true); // 放行 ≠ 不拦
    }
    // 非危险组合同样不吞（录入框里录 F5 / Ctrl+S 等正常成键）
    expect(shouldSwallowGuardEvent("F5", false, true, false)).toBe(false);
  });

  it("危险键 + window 级键位已认领：不吞（事件放行给 main.ts 分发，如 close_tab=Ctrl+W）", () => {
    expect(shouldSwallowGuardEvent("Ctrl+KeyW", false, false, true)).toBe(false);
    expect(shouldSwallowGuardEvent("Ctrl+KeyT", false, false, true)).toBe(false);
    // Monaco 内同理：认领与 Monaco 认领任一满足即放行
    expect(shouldSwallowGuardEvent("Ctrl+KeyW", true, false, false)).toBe(false);
    expect(shouldSwallowGuardEvent("Ctrl+KeyW", true, false, true)).toBe(false);
  });

  it("危险键 + 无人认领 + 非录入：照旧吞掉（防关窗口的原始保障不回归）", () => {
    expect(shouldSwallowGuardEvent("Ctrl+KeyW", false, false, false)).toBe(true);
    expect(shouldSwallowGuardEvent("Ctrl+KeyR", true, false, false)).toBe(true);
  });

  it("非危险、非认领组合：永不吞、也不 preventDefault 的影响面（普通打字不受影响）", () => {
    expect(shouldSwallowGuardEvent("KeyA", false, false, false)).toBe(false);
    expect(shouldSwallowGuardEvent("KeyA", false, true, false)).toBe(false);
    expect(isBlockedCombo("KeyA", false)).toBe(false);
  });
});
