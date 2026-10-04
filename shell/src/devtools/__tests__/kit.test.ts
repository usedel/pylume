// @vitest-environment happy-dom
// PR-1：ToolKit UI 积木测试（plugin_system_design §9.12）。
// 覆盖：输入规范兜底（autocomplete/spellcheck）、布局积木、按钮体系、清空目标。
// Monaco 的 output 因 happy-dom 无真实布局，仅验证容器与接口形状（不 create editor——
// kit.output 依赖 app.settings 与 monaco.editor.create，测试环境以注入假 monaco 走通装配）。

import { describe, expect, it } from "vitest";
import { createToolKit, type ToolKit } from "../kit";
import type { ToolHost } from "../types";

function makeHost(root: HTMLElement): ToolHost {
  return {
    root,
    monaco: {} as never,
    kit: null as never,
    workspaceRoot: () => null,
    copyToClipboard: async () => true,
    readClipboard: async () => "abc",
    getSelectedText: () => null,
    replaceSelection: () => false,
    insertToEditor: () => false,
  };
}

function makeKit(): { kit: ToolKit; host: ToolHost; root: HTMLElement } {
  const root = document.createElement("div");
  const host = makeHost(root);
  const kit = createToolKit(host);
  host.kit = kit;
  return { kit, host, root };
}

describe("ToolKit 输入积木", () => {
  it("textarea 兜底 autocomplete=off + spellcheck=false（输入框规范）", () => {
    const { kit } = makeKit();
    const ta = kit.textarea({ placeholder: "x" });
    expect(ta.autocomplete).toBe("off");
    expect(ta.spellcheck).toBe(false);
    expect(ta.placeholder).toBe("x");
    expect(ta.className).toContain("tool-textarea");
  });

  it("input 兜底同样的输入规范，Enter 触发 onEnter", () => {
    const { kit } = makeKit();
    let hit = "";
    const input = kit.input({ placeholder: "y", onEnter: (v) => (hit = v) });
    expect(input.autocomplete).toBe("off");
    expect(input.spellcheck).toBe(false);
    input.value = "hello";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(hit).toBe("hello");
  });

  it("flex 档 textarea 带修饰类", () => {
    const { kit } = makeKit();
    const ta = kit.textarea({ flex: true });
    expect(ta.className).toContain("tool-textarea--flex");
  });
});

describe("ToolKit 布局与按钮", () => {
  it("toolbar 支持 spacer 占位", () => {
    const { kit } = makeKit();
    const bar = kit.toolbar(kit.button("a"), "spacer", kit.button("b"));
    expect(bar.className).toBe("tool-toolbar");
    expect(bar.querySelector(".spacer")).not.toBeNull();
    expect(bar.querySelectorAll("button").length).toBe(2);
  });

  it("radioGroup：互斥选择语义（aria-checked 单一真源 + 漫游 tabindex）", () => {
    const { kit } = makeKit();
    let changed = "";
    const g = kit.radioGroup<"a" | "b">({
      label: "测试组",
      options: [
        { value: "a", label: "选项A" },
        { value: "b", label: "选项B" },
      ],
      value: "a",
      onChange: (v) => (changed = v),
    });
    expect(g.el.getAttribute("role")).toBe("radiogroup");
    expect(g.el.getAttribute("aria-label")).toBe("测试组");
    expect(g.get()).toBe("a");

    const radios = [...g.el.querySelectorAll<HTMLButtonElement>(".tool-radio")];
    expect(radios.length).toBe(2);
    // 初始：a 选中（aria-checked + tabIndex 0），b 未选（tabIndex -1）
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(radios[0].tabIndex).toBe(0);
    expect(radios[1].getAttribute("aria-checked")).toBe("false");
    expect(radios[1].tabIndex).toBe(-1);

    // 点击 b：互斥切换 + onChange
    radios[1].click();
    expect(g.get()).toBe("b");
    expect(radios[0].getAttribute("aria-checked")).toBe("false");
    expect(radios[0].tabIndex).toBe(-1);
    expect(radios[1].tabIndex).toBe(0);
    expect(changed).toBe("b");
  });

  it("按钮走 .btn 体系（primary 变体）", () => {
    const { kit } = makeKit();
    expect(kit.button("普通").className).toBe("btn");
    expect(kit.primaryButton("主按钮").className).toContain("btn--primary");
  });

  it("iconButton 带 data-tip + aria-label（UI-09 双补）", () => {
    const { kit } = makeKit();
    const btn = kit.iconButton("copy", "复制");
    expect(btn.dataset.tip).toBe("复制");
    expect(btn.getAttribute("aria-label")).toBe("复制");
  });

  it("errorSlot 是 .tool-error 槽", () => {
    const { kit } = makeKit();
    expect(kit.errorSlot().className).toBe("tool-error");
  });
});

describe("ToolKit clearButton", () => {
  it("同时清空 textarea 与 output 形状目标", () => {
    const { kit } = makeKit();
    const ta = kit.textarea({});
    ta.value = "text";
    let cleared = false;
    const fakeOutput = { el: document.createElement("div"), get: () => "", set: () => {}, clear: () => (cleared = true), dispose: () => {} };
    const btn = kit.clearButton(ta, fakeOutput);
    btn.click();
    expect(ta.value).toBe("");
    expect(cleared).toBe(true);
  });
});
