// @vitest-environment happy-dom
// 问题面板域单测：面板渲染 / 状态栏芯片 / 过滤 / 空态。
// app 单例（state.ts）共享：测试直接改 app.tabs / app.activeTab / app.monaco 的 mock。
// 点击跳转等交互行为由 e2e 覆盖（依赖注入后的真实 Monaco 实例）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../state";
import { renderProblems, activeFileProblemCounts } from "../problemsPanel";

const ERR = 8; // MarkerSeverity.Error
const WARN = 4; // MarkerSeverity.Warning

function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

beforeEach(() => {
  document.body.innerHTML = [
    '<div id="problems-panel"></div>',
    '<div id="status-problems" class="hidden"></div>',
    '<div id="tab-problems"></div>',
  ].join("");
  // app 默认引用在测试环境可能未初始化（monaco getter 抛错式），这里整体换成 mock
  vi.restoreAllMocks();
});

/** 构造 mock app（Object.defineProperty 覆盖 getter 抛错式的 monaco/editor） */
function mockApp(
  markersByPath: Record<string, Array<{ line: number; col: number; severity: number; message: string; source?: string }>>,
  activePath: string | null,
): void {
  const tabs = Object.keys(markersByPath).map((path) => ({
    path,
    kind: "file",
    model: { uri: { toString: () => `file:///${path}` } },
  }));
  const monaco = {
    editor: {
      getModelMarkers: ({ resource }: { resource: { toString(): string } }) => {
        const path = resource.toString().replace("file:///", "");
        return (markersByPath[path] ?? []).map((m) => ({
          startLineNumber: m.line,
          startColumn: m.col,
          endLineNumber: m.line,
          endColumn: m.col + 1,
          severity: m.severity,
          message: m.message,
          source: m.source,
        }));
      },
      onDidChangeMarkers: () => ({ dispose: () => {} }),
    },
    MarkerSeverity: { Error: ERR, Warning: WARN, Info: 2, Hint: 1 },
  };
  // 覆盖共享 app 的字段（monaco 是 getter，需 defineProperty）
  Object.defineProperty(app, "monaco", { value: monaco, configurable: true });
  (app as any).tabs = tabs;
  (app as any).activeTab = tabs.find((t) => t.path === activePath) ?? null;
}

describe("问题面板渲染", () => {
  it("有 error+warning → 面板分组列出、芯片计数、tab 徽标", () => {
    mockApp(
      {
        "a.py": [
          { line: 3, col: 1, severity: ERR, message: "Parse error: Expected an identifier", source: "pyrefly" },
          { line: 10, col: 5, severity: WARN, message: "E501 line too long", source: "E501" },
        ],
        "b.py": [{ line: 1, col: 1, severity: ERR, message: "undefined name", source: "pyrefly" }],
      },
      "a.py",
    );
    renderProblems();

    const panel = el("problems-panel");
    // 文件分组头（search-file 复用）
    expect(panel.querySelectorAll(".search-file-name").length).toBe(2);
    // 问题行
    expect(panel.querySelectorAll(".pb-item").length).toBe(3);
    // 状态栏芯片：当前文件 a.py → 1 错 1 警
    const chip = el("status-problems");
    expect(chip.classList.contains("hidden")).toBe(false);
    expect(chip.classList.contains("has-errors")).toBe(true);
    expect(chip.textContent).toContain("✕ 1");
    expect(chip.textContent).toContain("⚠ 1");
    // tab 徽标（全局错误 2）
    expect(el("tab-problems").textContent).toContain("(2)");
    // 过滤 chips（全部/错误/警告）
    expect(panel.querySelectorAll(".fu-chip").length).toBe(3);
  });

  it("无诊断 → 空态 + 芯片隐藏", () => {
    mockApp({ "a.py": [] }, "a.py");
    renderProblems();
    // S4（onboarding plan）：空态改用 emptyState 基建，desc 带 ruff 教学文案
    const empty = document.querySelector("#problems-panel .empty-state")!;
    expect(empty.textContent).toContain("没有发现问题");
    expect(empty.textContent).toContain("ruff");
    expect(el("status-problems").classList.contains("hidden")).toBe(true);
    expect(el("tab-problems").textContent).not.toContain("(");
  });

  it("Info 级不进面板", () => {
    mockApp({ "a.py": [{ line: 1, col: 1, severity: 2, message: "info", source: "pyrefly" }] }, "a.py");
    renderProblems();
    expect(document.querySelector("#problems-panel .empty-state")).toBeTruthy();
  });

  it("多行 message 只取首行展示", () => {
    mockApp({ "a.py": [{ line: 1, col: 1, severity: ERR, message: "first\nsecond", source: "pyrefly" }] }, "a.py");
    renderProblems();
    expect(document.querySelector(".pb-msg")!.textContent).toBe("first");
  });

  it("activeFileProblemCounts：只算活动文件", () => {
    mockApp(
      {
        "a.py": [
          { line: 1, col: 1, severity: ERR, message: "e", source: "pyrefly" },
          { line: 2, col: 1, severity: ERR, message: "e", source: "pyrefly" },
          { line: 3, col: 1, severity: WARN, message: "w", source: "ruff" },
        ],
        "b.py": [{ line: 1, col: 1, severity: ERR, message: "e", source: "pyrefly" }],
      },
      "a.py",
    );
    expect(activeFileProblemCounts()).toEqual({ errors: 2, warnings: 1 });
  });
});
