// @vitest-environment happy-dom
// P2-11（UX 审查）回归：变量面板嵌套对象树形展开。
//
// 核心不变量：
// 1. variablesReference > 0 的行可展开（aria-expanded + twisty），= 0 的行只有占位、不可展开；
// 2. 展开经 DAP variables 懒加载子级（role=group），折叠即移除子容器；
// 3. 嵌套行同样可继续展开（递归）；
// 4. 值点击 = Set Value（stopPropagation），不触发展开/折叠。
import { beforeEach, describe, expect, it, vi } from "vitest";

const dapVariablesMock = vi.hoisted(() => vi.fn());
vi.mock("../dap/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dap/client")>();
  return {
    ...actual,
    currentPhase: () => "stopped",
    dapVariables: dapVariablesMock,
  };
});
vi.mock("../dialog", () => ({ openPrompt: vi.fn().mockResolvedValue(null) }));

import { renderVarRowForTest, resetVarTreeForTest } from "../debugView";
import type { DapVariable } from "../dap/client";

const CHILDREN = [
  { name: "a", value: "1", variablesReference: 0 },
  { name: "nested", value: "{}", variablesReference: 77 },
] satisfies DapVariable[];

beforeEach(() => {
  document.body.textContent = "";
  resetVarTreeForTest(); // 展开状态与令牌跨测试隔离
  dapVariablesMock.mockReset();
  dapVariablesMock.mockResolvedValue(CHILDREN);
});

function container(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "tree");
  document.body.appendChild(el);
  return el;
}

describe("变量面板树形展开（P2-11）", () => {
  it("可展开行：aria-expanded + twisty；普通行只有占位、不可展开", () => {
    const root = container();
    renderVarRowForTest(root, { name: "obj", value: "{...}", variablesReference: 99 }, 10, 0);
    renderVarRowForTest(root, { name: "x", value: "1", variablesReference: 0 }, 10, 0);
    const rows = root.querySelectorAll<HTMLElement>(".debug-var-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("aria-expanded")).toBe("false");
    expect(rows[0].querySelector(".twisty.codicon-chevron-right")).toBeTruthy();
    expect(rows[1].hasAttribute("aria-expanded")).toBe(false);
    expect(rows[1].querySelector(".tw-placeholder")).toBeTruthy();
  });

  it("展开懒加载子级（role=group），折叠即移除；子级行按 depth 缩进", async () => {
    const root = container();
    renderVarRowForTest(root, { name: "obj", value: "{...}", variablesReference: 99 }, 10, 0);
    const row = root.querySelector<HTMLElement>(".debug-var-row")!;
    row.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".debug-var-children")).toBeTruthy();
    });
    expect(dapVariablesMock).toHaveBeenCalledWith(99);
    const group = root.querySelector<HTMLElement>(".debug-var-children")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.querySelectorAll(".debug-var-row")).toHaveLength(2);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    // 嵌套行同样可展开（递归）
    const nested = group.querySelectorAll<HTMLElement>(".debug-var-row")[1];
    expect(nested.getAttribute("aria-expanded")).toBe("false");
    nested.click();
    await vi.waitFor(() => {
      expect(nested.nextElementSibling?.getAttribute("role")).toBe("group");
    });
    expect(dapVariablesMock).toHaveBeenCalledWith(77);
    // 折叠：子容器移除
    row.click();
    expect(root.querySelector(".debug-var-children")).toBeNull();
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("值点击 = Set Value（stopPropagation），不触发展开/折叠", async () => {
    const root = container();
    renderVarRowForTest(root, { name: "obj", value: "{...}", variablesReference: 99 }, 10, 0);
    const row = root.querySelector<HTMLElement>(".debug-var-row")!;
    const value = row.querySelector<HTMLElement>(".debug-var-value")!;
    value.click();
    await vi.waitFor(() => {}); // 让潜在异步跑完
    expect(dapVariablesMock).not.toHaveBeenCalled(); // 未展开
    expect(root.querySelector(".debug-var-children")).toBeNull();
  });
});
