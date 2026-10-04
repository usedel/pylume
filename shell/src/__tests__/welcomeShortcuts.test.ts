// @vitest-environment happy-dom
// UI-25 回归：欢迎页快捷键网格跟随键位系统。
//
// 核心不变量：网格里的键位必须来自 app.settings.keybindings（经 bindingLabel），不是硬编码常量。
// 改动前是 index.html 里 6 行写死的 <kbd>，用户在设置里改键后欢迎页仍显示出厂默认值——
// 这类「静态副本」缺陷不会报错、也不会崩溃，只是悄悄给出错误信息，故用测试钉住。
// 一并钉住：解绑时的占位（不能渲染空 kbd 框、也不能整行消失）、F12 兜底、Monaco 内建项保持固定。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWelcomeShortcuts } from "../welcomeShortcuts";
import { app, DEFAULT_SETTINGS } from "../state";

/** 说明文字 → 该行的 kbd 分段（无 kbd 时返回占位文本） */
function rowOf(label: string): { kbds: string[]; placeholder: string } {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".ew-shortcut"));
  const row = rows.find((r) => r.querySelector(".label")?.textContent === label);
  if (!row) throw new Error(`未渲染「${label}」行`);
  return {
    kbds: Array.from(row.querySelectorAll("kbd")).map((k) => k.textContent ?? ""),
    placeholder: row.querySelector(".ew-kbd-none")?.textContent ?? "",
  };
}

/** 换一份键位表（不就地改：app.settings.keybindings 与 DEFAULT_SETTINGS 共享同一对象引用） */
function setBindings(patch: Record<string, string>): void {
  app.settings.keybindings = { ...DEFAULT_SETTINGS.keybindings, ...patch };
}

beforeEach(() => {
  document.body.innerHTML = "";
  const grid = document.createElement("div");
  grid.id = "ew-shortcuts";
  grid.className = "ew-shortcuts";
  document.body.appendChild(grid);
  app.settings.keybindings = { ...DEFAULT_SETTINGS.keybindings };
});

afterEach(() => {
  app.settings.keybindings = { ...DEFAULT_SETTINGS.keybindings };
});

describe("欢迎页快捷键网格（UI-25）", () => {
  // 行数演进：13（UI-25 初版）→ 14（v3.4 §17-7 run 拆分）→ 17（PR-A 删除行/重开标签、
  // PR-D 上一个编辑位置）→ 18（PR-G 转到文件内符号）→ 19（PR-J 触发补全建议）。
  // 登记修复（2026-09-27）：本文件此前长期落在「本机 happy-dom 环境竞态」损坏名单内从未真正
  // 执行，PR-A/D/G/J 四次加行均未同步此处断言；环境以 pool=vmThreads 绕过后本锁恢复生效。
  const ROW_COUNT = 19;

  it("出厂键位：条目齐全，键位按 + 拆成独立 kbd 分段", () => {
    renderWelcomeShortcuts();
    expect(document.querySelectorAll(".ew-shortcut").length).toBe(ROW_COUNT);
    expect(rowOf("保存文件").kbds).toEqual(["Ctrl", "S"]);
    expect(rowOf("全局搜索").kbds).toEqual(["Ctrl", "Shift", "F"]);
    expect(rowOf("运行脚本").kbds).toEqual(["Ctrl", "F10"]);
    expect(rowOf("运行项目").kbds).toEqual(["Ctrl", "Shift", "F10"]);
    // P1 新增行（此前键位无处可发现的高频操作）
    expect(rowOf("关闭标签").kbds).toEqual(["Ctrl", "F4"]);
    expect(rowOf("新建文件").kbds).toEqual(["Ctrl", "Alt", "Insert"]);
    expect(rowOf("打开设置").kbds).toEqual(["Ctrl", "Alt", "S"]);
  });

  it("用户改键后重绘即跟随（本条是 UI-25 的核心不变量）", () => {
    setBindings({ save: "Ctrl+Alt+P", global_search: "Ctrl+G" });
    renderWelcomeShortcuts();
    expect(rowOf("保存文件").kbds).toEqual(["Ctrl", "Alt", "P"]);
    expect(rowOf("全局搜索").kbds).toEqual(["Ctrl", "G"]);
  });

  it("重绘幂等：连续渲染不累积行", () => {
    renderWelcomeShortcuts();
    renderWelcomeShortcuts();
    expect(document.querySelectorAll(".ew-shortcut").length).toBe(ROW_COUNT);
  });

  it("解绑且无兜底 → 显示「未绑定」占位，不渲染空 kbd 框、也不整行消失", () => {
    setBindings({ save: "" });
    renderWelcomeShortcuts();
    const row = rowOf("保存文件");
    expect(row.kbds).toEqual([]);
    expect(row.placeholder).toBe("未绑定");
    expect(document.querySelectorAll(".ew-shortcut").length).toBe(ROW_COUNT); // 行仍在：动作没消失，只是没键
  });

  it("「跳转到定义」解绑时回落 F12（Monaco 固定保留该键，不该报未绑定）", () => {
    setBindings({ goto_definition: "" });
    renderWelcomeShortcuts();
    expect(rowOf("跳转到定义").kbds).toEqual(["F12"]);
    expect(rowOf("跳转到定义").placeholder).toBe("");
  });

  it("「跳转到定义」改键后跟随配置（默认 Ctrl+B，不再恒显 F12）", () => {
    renderWelcomeShortcuts();
    expect(rowOf("跳转到定义").kbds).toEqual(["Ctrl", "B"]);
    setBindings({ goto_definition: "F12" });
    renderWelcomeShortcuts();
    expect(rowOf("跳转到定义").kbds).toEqual(["F12"]);
  });

  it("Monaco 内建项（查找引用 / 格式化文档）不在键位系统内，保持固定键位", () => {
    setBindings({ save: "Ctrl+P" }); // 改一个无关项，确认这两行不受影响
    renderWelcomeShortcuts();
    expect(rowOf("查找引用").kbds).toEqual(["Shift", "F12"]);
    expect(rowOf("格式化文档").kbds).toEqual(["Shift", "Alt", "F"]);
  });

  it("每行都有说明文字（kbd 分段不能挤掉 label）", () => {
    renderWelcomeShortcuts();
    const labels = Array.from(document.querySelectorAll<HTMLElement>(".ew-shortcut .label")).map(
      (l) => l.textContent,
    );
        expect(labels).toEqual([
      "保存文件", "全局搜索", "运行脚本", "运行项目", "跳转到定义", "查找引用", "格式化文档",
      "启动调试", "关闭标签", "删除行", "重新打开关闭的标签", "上一个编辑位置", "新建文件",
      "转到文件", "转到文件内符号", "触发补全建议", "导航后退", "最近打开的文件", "打开设置",
    ]);
  });
});
