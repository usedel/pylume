// @vitest-environment happy-dom
// UI-16 回归：侧栏视图切换的 tabs 语义。
//
// 核心不变量：setSidebarTab 切换 .active 类（视觉）时必须同源切换 aria-selected（读屏）。
// 二者一旦分家（如后人新增切换路径只改类名），读屏报出的「已选中」会与实际面板不符，
// 且视觉上完全看不出来——静默的无障碍回归。
import { beforeAll, describe, expect, it } from "vitest";
import { activeView, registerSidebarView, setSidebarTab } from "../views";

const VIEW_IDS = ["files", "search"] as const;

beforeAll(() => {
  for (const id of VIEW_IDS) {
    const root = document.createElement("div");
    root.id = `view-${id}`;
    root.classList.add("hidden");
    document.body.appendChild(root);
    const tab = document.createElement("button");
    tab.id = `tab-${id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("aria-controls", `view-${id}`);
    document.body.appendChild(tab);
  }
  registerSidebarView({ id: "files", rootId: "view-files", tabId: "tab-files" });
  registerSidebarView({ id: "search", rootId: "view-search", tabId: "tab-search" });
});

describe("侧栏视图切换（UI-16：aria-selected 与 .active 同源）", () => {
  it("激活 files：tab 报 aria-selected=true，对应面板解除隐藏", () => {
    setSidebarTab("files");
    expect(activeView()).toBe("files");
    expect(document.getElementById("tab-files")!.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("tab-files")!.classList.contains("active")).toBe(true);
    expect(document.getElementById("view-files")!.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("tab-search")!.getAttribute("aria-selected")).toBe("false");
  });

  it("切到 search：旧 tab 的 aria-selected 与 .active 一起复位", () => {
    setSidebarTab("search");
    expect(document.getElementById("tab-files")!.getAttribute("aria-selected")).toBe("false");
    expect(document.getElementById("tab-files")!.classList.contains("active")).toBe(false);
    expect(document.getElementById("tab-search")!.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("view-search")!.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("view-files")!.classList.contains("hidden")).toBe(true);
  });

  it("任意时刻至多一个 tab 报 aria-selected=true（tabs 模式的互斥语义）", () => {
    setSidebarTab("files");
    const selected = VIEW_IDS.filter(
      (id) => document.getElementById(`tab-${id}`)!.getAttribute("aria-selected") === "true",
    );
    expect(selected).toEqual(["files"]);
  });
});
