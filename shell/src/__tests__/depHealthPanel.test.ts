// @vitest-environment happy-dom
// 依赖健康面板（dep plan M3）：三视图渲染 / 四级横幅优先级 / 行级忽略流 / 状态栏体检图标。
// DOM 骨架必须在首次 import 前就位——depHealthPanel/envPanel 的顶层 $() 缺元素即抛（CR-26）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DepDiff } from "../depHealth";
import { app } from "../state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../toast", () => ({ toast: vi.fn(), toastFail: vi.fn() }));
vi.mock("../dialog", () => ({ openConfirm: vi.fn(), openAlert: vi.fn() }));

const IDS = [
  "output", "bottom", "env-modal", "env-packages",
  "env-pkg-input", "env-pkg-filter", "env-pkg-count", "env-pkg-upgrade-all", "env-pkg-uninstall-selected",
  "status-interpreter", "dep-health-banner", "dep-health-banner-text", "dep-health-banner-actions",
  "dep-style-badge", "dep-interp-label", "dep-scanned-at", "dep-health-content", "dep-health-status",
  "dep-health-detail",
  // 自定义解释器下拉（#2 决策 1=3b）+ 创建流程的版本选择模态
  "interp-trigger-label", "interp-popover", "interp-select",
  "venv-version-modal", "venv-version-list", "venv-version-hint",
];
const BUTTON_IDS = ["dep-refresh", "dep-tab-edge", "dep-tab-file", "dep-tab-ignored",
  "env-pkg-install", "env-close", "dep-collapse", "interp-trigger", "venv-version-close"];
for (const id of IDS) {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
}
for (const id of BUTTON_IDS) {
  const el = document.createElement("button");
  el.id = id;
  document.body.appendChild(el);
}
document.getElementById("env-modal")!.classList.add("hidden");

const panel = await import("../depHealthPanel");
const dh = await import("../depHealth");
const { invoke } = await import("@tauri-apps/api/core");
const { toast } = await import("../toast");

panel.initDepHealthPanel({ openEnvPanel: vi.fn(), refreshPackagesIfOpen: vi.fn(), repaintPackagesIfOpen: vi.fn() });
dh.initDepHealth({ restartEngine: async () => {} });

/** 构造一份 DepDiff（缺省 = 契约的「一切正常」形态，同 depHealth.test.ts 口径） */
function fakeDiff(over: Partial<DepDiff> = {}): DepDiff {
  return {
    style: "pyproject",
    externalManager: null,
    missingInEnv: [],
    declaredMissing: [],
    declaredMissingModules: [],
    envDrift: [],
    undeclared: [],
    lockOutOfDate: false,
    requirementsUninstalled: false,
    interpreter: "F:/ws/.venv/Scripts/python.exe",
    requirementsFile: null,
    scannedAt: Date.now(),
    ...over,
  };
}

/** 播种 diff 快照：mock invoke 后走真实 runDepScan（与生产同一落快照路径） */
async function seedDiff(over: Partial<DepDiff> = {}): Promise<void> {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "dep_scan") return fakeDiff(over);
    if (cmd === "dep_style") {
      return {
        style: over.style ?? "pyproject",
        externalManager: over.externalManager ?? null,
        requirementsFile: over.requirementsFile ?? null,
      };
    }
    if (cmd === "dep_env_snapshot") return [];
    if (cmd === "dep_ignore_list") return [];
    return undefined as never;
  });
  await dh.runDepScan("F:/ws");
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};
const contentEl = (): HTMLElement => document.getElementById("dep-health-content")!;
const bannerEl = (): HTMLElement => document.getElementById("dep-health-banner")!;
const findBtn = (root: HTMLElement, label: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);

beforeEach(() => {
  app.workspaceRoot = "F:/ws";
  vi.mocked(invoke).mockReset();
  vi.mocked(toast).mockReset();
  dh.resetDepHealth();
  panel.resetDepHealthPanel();
});

// ---------- 三视图渲染（§6.1） ----------

describe("三视图渲染（§6.1：按断边默认 / 按文件 / 已忽略）", () => {
  it("按断边：五组 + 行级条目（模块/dist 归一/file:line）+ 头部徽章与扫描时间", async () => {
    await seedDiff({
      missingInEnv: [{ module: "yaml", dist: "PyYAML", distCandidates: ["PyYAML"], file: "a.py", line: 3, lazy: false }],
      envDrift: [{ dist: "numpy", version: "2.0" }],
    });
    await panel.renderDepHealth();
    const content = contentEl();
    expect(content.querySelectorAll(".dep-group[data-edge]").length).toBe(5);
    expect(content.textContent).toContain("E1 缺失模块");
    expect(content.textContent).toContain("yaml");
    expect(content.textContent).toContain("PyYAML");   // dist 归一结果呈现
    expect(content.textContent).toContain("a.py:3");   // 文件位点
    expect(content.textContent).toContain("numpy");    // E3 漂移行
    expect(document.getElementById("dep-style-badge")!.textContent).toBe("pyproject");
    expect(document.getElementById("dep-scanned-at")!.textContent).toContain("上次扫描");
    expect(document.getElementById("dep-interp-label")!.textContent).toBe(".venv");
  });

  it("external：E2~E5 显示「已降级」而非空列表（§9.1 边界验收）", async () => {
    await seedDiff({ style: "external", externalManager: "poetry", interpreter: null });
    await panel.renderDepHealth();
    const content = contentEl();
    const counts = Array.from(content.querySelectorAll(".dep-group-count")).map((e) => e.textContent);
    expect(counts.filter((c) => c === "已降级").length).toBe(4); // e2~e5
    expect(content.textContent).toContain("poetry");
    expect(document.getElementById("dep-style-badge")!.textContent).toBe("external·poetry");
  });

  it("interpreter=null：环境侧组显式呈现「检测不可用」（§3.3 契约行为）", async () => {
    await seedDiff({ interpreter: null });
    await panel.renderDepHealth();
    expect(document.getElementById("dep-interp-label")!.textContent).toContain("未选解释器");
    expect(contentEl().textContent).toContain("环境侧检测不可用");
  });

  it("requirements 项目：附迁移引导行（R4：迁移而非原地维护）", async () => {
    await seedDiff({ style: "requirements", requirementsFile: "requirements.txt" });
    await panel.renderDepHealth();
    expect(contentEl().textContent).toContain("迁移建议");
    expect(findBtn(contentEl(), "迁移到 pyproject")).toBeDefined();
  });

  it("按文件：E1/E4 按文件聚合 + 行号跳转条目", async () => {
    await seedDiff({
      missingInEnv: [{ module: "yaml", dist: "PyYAML", distCandidates: ["PyYAML"], file: "sub/a.py", line: 3, lazy: false }],
      undeclared: [{ module: "numpy", dist: "numpy", distCandidates: ["numpy"], file: "sub/a.py", line: 7 }],
    });
    await panel.renderDepHealth();
    document.getElementById("dep-tab-file")!.click();
    await flush();
    const content = contentEl();
    expect(content.textContent).toContain("sub/a.py");
    expect(content.textContent).toContain("L3");
    expect(content.textContent).toContain("E1 缺失");
    expect(content.textContent).toContain("L7");
    expect(content.textContent).toContain("E4 未声明");
  });

  it("已忽略：清单渲染 + 「恢复检测」→ dep_ignore_remove + 重扫（§5.3）", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "dep_scan") return fakeDiff();
      if (cmd === "dep_ignore_list") return [{ edge: "e1", key: "foo" }];
      if (cmd === "dep_ignore_remove") return [];
      return undefined as never;
    });
    await dh.runDepScan("F:/ws");
    await panel.renderDepHealth();
    document.getElementById("dep-tab-ignored")!.click();
    await flush();
    const content = contentEl();
    expect(content.textContent).toContain("foo");
    expect(content.textContent).toContain("E1 缺失模块");
    findBtn(content, "恢复检测")!.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("dep_ignore_remove", {
      workspaceRoot: "F:/ws", edge: "e1", key: "foo",
    });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("foo"), "success");
  });

  it("空清单提示引导（已忽略视图空态）", async () => {
    await seedDiff();
    await panel.renderDepHealth();
    document.getElementById("dep-tab-ignored")!.click();
    await flush();
    expect(contentEl().textContent).toContain("无忽略项");
  });
});

// ---------- 四级健康横幅（§6.2：同一时刻最多一条，高优先级胜出） ----------

describe("四级健康横幅（§6.2）", () => {
  it("优先级 1：external 边界横幅压过一切（含漂移数据在场）+「了解迁移」", async () => {
    await seedDiff({
      style: "external", externalManager: "poetry", interpreter: null,
      envDrift: [{ dist: "x", version: "1" }], // 契约上 external 不会有漂移，仍验证优先级压制
    });
    await panel.renderDepHealth();
    expect(bannerEl().classList.contains("hidden")).toBe(false);
    expect(document.getElementById("dep-health-banner-text")!.textContent).toContain("poetry");
    expect(document.getElementById("dep-health-banner-text")!.textContent).toContain("降级");
    expect(findBtn(document.getElementById("dep-health-banner-actions")!, "了解迁移")).toBeDefined();
  });

  it("优先级 2：bare → 生成 pyproject.toml（点击调 init_pyproject，原横幅动作迁入）", async () => {
    await seedDiff({ style: "bare", interpreter: null });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "init_pyproject") return "已生成 pyproject.toml";
      if (cmd === "dep_style") return { style: "bare", externalManager: null, requirementsFile: null };
      if (cmd === "dep_scan") return fakeDiff({ style: "bare", interpreter: null });
      return undefined as never;
    });
    await panel.renderDepHealth();
    const btn = findBtn(document.getElementById("dep-health-banner-actions")!, "生成 pyproject.toml")!;
    expect(btn).toBeDefined();
    btn.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("init_pyproject", { workspaceRoot: "F:/ws" });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("已生成"), "success");
  });

  it("优先级 3：requirementsUninstalled →「安装缺失依赖」+「迁移到 pyproject」（反馈 1）", async () => {
    await seedDiff({
      style: "requirements", requirementsFile: "requirements.txt",
      requirementsUninstalled: true,
      declaredMissing: [{ dist: "flask", spec: "" }, { dist: "requests", spec: ">=2" }],
    });
    await panel.renderDepHealth();
    expect(document.getElementById("dep-health-banner-text")!.textContent).toContain("未安装");
    const actions = document.getElementById("dep-health-banner-actions")!;
    expect(findBtn(actions, "安装缺失依赖")).toBeDefined();
    expect(findBtn(actions, "迁移到 pyproject")).toBeDefined();
  });

  it("优先级 3（部分缺失）：E2 非空 → 同步环境（pyproject 文案）", async () => {
    await seedDiff({ declaredMissing: [{ dist: "flask", spec: ">=3" }] });
    await panel.renderDepHealth();
    expect(document.getElementById("dep-health-banner-text")!.textContent).toContain("1 个已声明依赖未安装");
    expect(findBtn(document.getElementById("dep-health-banner-actions")!, "同步环境")).toBeDefined();
  });

  it("优先级 4：envDrift →「写入 pyproject」+「查看」（反馈 2）", async () => {
    await seedDiff({ envDrift: [{ dist: "numpy", version: "2.0" }] });
    await panel.renderDepHealth();
    expect(document.getElementById("dep-health-banner-text")!.textContent).toContain("已安装但未声明");
    expect(document.getElementById("dep-health-banner-text")!.textContent).toContain("pip 安装不写入声明属正常现象");
    const actions = document.getElementById("dep-health-banner-actions")!;
    expect(findBtn(actions, "写入 pyproject")).toBeDefined();
    expect(findBtn(actions, "查看")).toBeDefined();
  });

  it("一切正常 / 未体检 → 无横幅", async () => {
    await seedDiff();
    await panel.renderDepHealth();
    expect(bannerEl().classList.contains("hidden")).toBe(true);
  });
});

// ---------- 行级动作（§5.3：忽略写清单；修复走统一编排） ----------

describe("行级动作（§5.3）", () => {
  it("行级「忽略」→ dep_ignore_add + toast + 重扫（后端过滤单一口径）", async () => {
    await seedDiff({ envDrift: [{ dist: "numpy", version: "2.0" }] });
    await panel.renderDepHealth();
    findBtn(contentEl(), "忽略")!.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("dep_ignore_add", {
      workspaceRoot: "F:/ws", edge: "e3", key: "numpy",
    });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("numpy"), "success");
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "dep_scan").length).toBeGreaterThan(1); // 重扫
  });

  it("组级「全部修复」按钮：E1 有缺失时出现（批量预览入口）", async () => {
    await seedDiff({ missingInEnv: [{ module: "yaml", dist: "PyYAML", distCandidates: ["PyYAML"], file: "a.py", line: 1, lazy: false }] });
    await panel.renderDepHealth();
    expect(findBtn(contentEl(), "全部修复")).toBeDefined();
  });

  it("修复按钮带 .dep-fix-btn 标记（§5.6-3 执行期统一禁用的选择器锚点）", async () => {
    await seedDiff({ missingInEnv: [{ module: "yaml", dist: "PyYAML", distCandidates: ["PyYAML"], file: "a.py", line: 1, lazy: false }] });
    await panel.renderDepHealth();
    expect(contentEl().querySelectorAll(".dep-fix-btn").length).toBeGreaterThan(0);
  });

  it("v1.7 B：E1 按模块聚合——同模块多文件一行 + 展开明细；v1.7 A：E2 小节汇总已声明未装", async () => {
    await seedDiff({
      missingInEnv: [
        { module: "ghost", dist: null, distCandidates: [], file: "a.py", line: 1, lazy: false },
        { module: "ghost", dist: null, distCandidates: [], file: "b.py", line: 2, lazy: false },
        { module: "ghost", dist: null, distCandidates: [], file: "c.py", line: 3, lazy: true },
      ],
      declaredMissingModules: [
        { module: "pytest", dist: "pytest", group: "dev", files: 5, file: "tests/conftest.py", line: 2, lazy: false },
      ],
    });
    await panel.renderDepHealth();
    const content = contentEl();
    // B：ghost 一行（含「3 个文件」徽标）+ 2 行展开明细
    expect(content.textContent).toContain("3 个文件");
    expect(content.querySelectorAll(".dep-row--sub").length).toBe(2);
    // A：E2 小节呈现（组名 + 文件计数 + 跳转锚点）
    expect(content.textContent).toContain("已声明未安装（代码引用）");
    expect(content.textContent).toContain("组 dev");
    expect(content.textContent).toContain("5 个文件引用");
    expect(content.textContent).toContain("tests/conftest.py:2");
    // E2 组计数含小节条目（groupMeta 聚合口径）
    const e2 = content.querySelector(".dep-group[data-edge='e2'] .dep-group-count")!;
    expect(e2.textContent).toContain("1 项");
  });
});

// ---------- 状态栏体检图标（§4.5：转圈→完成即消；异常驻留，点击开面板） ----------

describe("状态栏体检图标（§4.5）", () => {
  const statusEl = (): HTMLElement => document.getElementById("dep-health-status")!;

  it("异常 diff → 驻留警示态（issues 类 + 计数 tooltip）", () => {
    panel.handleScanComplete(fakeDiff({ envDrift: [{ dist: "a", version: "1" }] }));
    expect(statusEl().classList.contains("hidden")).toBe(false);
    expect(statusEl().classList.contains("issues")).toBe(true);
    expect(statusEl().dataset.tip).toContain("1 项问题");
  });

  it("正常 diff → 熄灭（完成即消）；扫描失败（null）→ 熄灭", () => {
    panel.handleScanComplete(fakeDiff());
    expect(statusEl().classList.contains("hidden")).toBe(true);
    panel.handleScanComplete(fakeDiff({ envDrift: [{ dist: "a", version: "1" }] }));
    panel.handleScanComplete(null);
    expect(statusEl().classList.contains("hidden")).toBe(true);
  });

  it("scanning → 转圈态可见（打开工作区体检的进度指示）", () => {
    panel.setHealthStatus("scanning");
    expect(statusEl().classList.contains("hidden")).toBe(false);
    expect(statusEl().querySelector(".codicon-modifier-spin")).not.toBeNull();
  });

  it("resetDepHealthPanel 复位图标与投影 DOM（工作区切换）", () => {
    panel.handleScanComplete(fakeDiff({ envDrift: [{ dist: "a", version: "1" }] }));
    panel.resetDepHealthPanel();
    expect(statusEl().classList.contains("hidden")).toBe(true);
    expect(contentEl().textContent).toBe("");
  });
});
