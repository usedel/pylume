// @vitest-environment happy-dom
// 依赖健康域（dep plan M1/PR2）：契约摘要渲染 / §4.7 打开编排（弹窗排队、令牌丢弃）/ 快照新鲜度。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DepHealthModule from "../depHealth";
import type { DepDiff } from "../depHealth";
import { app } from "../state";
import { invoke } from "@tauri-apps/api/core"; // mocked（vi.mock 工厂）；旧用例的局部同名 const 遮蔽不受影响
import { toast, toastFail } from "../toast";
import { openConfirm } from "../dialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// M3：修复编排（runDepFix）与异常 toast 的断言依赖——mock 掉确认框与 toast（不渲染真实 UI）
// M4-4：resolveDistForInstall 的候选选择依赖 openChoice
vi.mock("../toast", () => ({ toast: vi.fn(), toastFail: vi.fn() }));
vi.mock("../dialog", () => ({ openConfirm: vi.fn(), openAlert: vi.fn(), openChoice: vi.fn() }));

let dh: typeof DepHealthModule;
let outputEl: HTMLElement;

/** 构造一份 DepDiff（缺省字段 = 契约的「一切正常」形态） */
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

beforeEach(async () => {
  if (!document.getElementById("output")) {
    const el = document.createElement("div");
    el.id = "output";
    document.body.appendChild(el);
  }
  // runDepFix 的 §5.6-2「展开底部输出面板」需要 #bottom（$ 缺元素即抛，CR-26）
  if (!document.getElementById("bottom")) {
    const el = document.createElement("div");
    el.id = "bottom";
    document.body.appendChild(el);
  }
  outputEl = document.getElementById("output")!;
  outputEl.textContent = "";
  // 清掉测试用模态
  for (const m of Array.from(document.querySelectorAll(".modal"))) m.remove();
  vi.mocked(await import("@tauri-apps/api/core")).invoke.mockReset();
  vi.mocked(toast).mockReset();
  vi.mocked(toastFail).mockReset();
  vi.mocked(openConfirm).mockReset();
  dh = await import("../depHealth");
  dh.resetDepHealth();
  vi.useRealTimers();
});

describe("summarizeDiff（M1 输出面板摘要行）", () => {
  it("正常形态：style + 解释器 + E 组计数 + 耗时", () => {
    const s = dh.summarizeDiff(fakeDiff(), 1234);
    expect(s).toContain("依赖体检：pyproject");
    expect(s).toContain("解释器 ✓");
    expect(s).toContain("E1 缺失 0");
    expect(s).toContain("耗时 1234ms");
  });

  it("external 徽章带管理器名（§4.2.1 边界可见性）", () => {
    const s = dh.summarizeDiff(fakeDiff({ style: "external", externalManager: "poetry", interpreter: null }), 10);
    expect(s).toContain("external(poetry)");
    expect(s).toContain("未选解释器（环境侧检测不可用）");
  });

  it("异常旗标：lock 过期与 requirements 未安装显式呈现", () => {
    const s = dh.summarizeDiff(
      fakeDiff({
        style: "requirements",
        requirementsFile: "requirements.txt",
        interpreter: null,
        lockOutOfDate: true,
        requirementsUninstalled: true,
      }),
      5,
    );
    expect(s).toContain("uv.lock 过期");
    expect(s).toContain("requirements 未安装");
  });
});

describe("快照新鲜度（§5.4/R8：30s 内复用）", () => {
  it("runDepScan 落快照；窗口内 fresh、窗口外 stale", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.mocked(invoke).mockResolvedValue(fakeDiff({ scannedAt: now }));
    await dh.runDepScan("F:/ws");
    expect(dh.latestDiff()).not.toBeNull();
    expect(dh.diffIsFresh(now)).toBe(true);
    expect(dh.diffIsFresh(now + 29_999)).toBe(true);  // 窗口内（<30s）
    expect(dh.diffIsFresh(now + 30_000)).toBe(false); // 边界外（=30s 即 stale）
    vi.spyOn(Date, "now").mockRestore();
  });

  it("freshDiffForInterpreter：解释器不匹配的快照不可复用（v1.3 ⑫，防切换后漏报）", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(fakeDiff({ interpreter: "F:/ws/.venv/Scripts/python.exe" }));
    await dh.runDepScan("F:/ws");
    // 匹配 → 可复用
    expect(dh.freshDiffForInterpreter("F:/ws/.venv/Scripts/python.exe")).not.toBeNull();
    // 切换到别的解释器 / uv run 兜底 → 环境事实已变，快照不可信
    expect(dh.freshDiffForInterpreter("D:/py3/python.exe")).toBeNull();
    expect(dh.freshDiffForInterpreter(null)).toBeNull();
  });

  it("resetDepHealth 清快照（工作区切换语义）", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(fakeDiff());
    await dh.runDepScan("F:/ws");
    expect(dh.latestDiff()).not.toBeNull();
    dh.resetDepHealth();
    expect(dh.latestDiff()).toBeNull();
  });
});

describe("运行前预检消费（§5.4）", () => {
  it("toWorkspaceRelative：绝对路径 → diff 的 file 键口径（相对 + 正斜杠，Windows 大小写不敏感）", () => {
    expect(dh.toWorkspaceRelative("F:\\ws\\sub\\a.py", "F:\\ws")).toBe("sub/a.py");
    expect(dh.toWorkspaceRelative("f:/WS/sub/a.py", "F:\\ws")).toBe("sub/a.py");
    expect(dh.toWorkspaceRelative("F:\\ws\\a.py", "F:\\ws\\")).toBe("a.py");
    expect(dh.toWorkspaceRelative("G:\\other\\a.py", "F:\\ws")).toBeNull(); // 工作区外
    expect(dh.toWorkspaceRelative("F:\\ws\\a.py", null)).toBeNull();         // 无工作区
  });

  it("missingForFile：只取该文件、剔除 lazy、按行排序、stmt 近似还原", () => {
    const d = fakeDiff({
      missingInEnv: [
        { module: "pandas", dist: null, distCandidates: [], file: "sub/a.py", line: 9, lazy: false },
        { module: "numpy", dist: "numpy", distCandidates: ["numpy"], file: "sub/a.py", line: 3, lazy: false },
        { module: "scipy", dist: null, distCandidates: [], file: "sub/a.py", line: 20, lazy: true },  // 惰性：不阻塞预检（M4-1 起由 lazyHintLine 提示）
        { module: "requests", dist: "requests", distCandidates: ["requests"], file: "b.py", line: 1, lazy: false }, // 别的文件
      ],
    });
    const m = dh.missingForFile(d, "sub/a.py");
    expect(m).toEqual([
      { name: "numpy", line: 3, stmt: "import numpy" },
      { name: "pandas", line: 9, stmt: "import pandas" },
    ]);
    // 大小写不敏感匹配（Windows 路径来源间大小写不稳定）
    expect(dh.missingForFile(d, "SUB/A.py").length).toBe(2);
    expect(dh.missingForFile(d, "c.py")).toEqual([]);
  });

  it("v1.7 ⑤：missingForFile / lazyMissingForFile 剔除已声明未装（declaredMissingModules 归 E2 小节，预检不二次打扰）", () => {
    const d = fakeDiff({
      missingInEnv: [
        { module: "pytest", dist: "pytest", distCandidates: ["pytest"], file: "t/a.py", line: 1, lazy: false },
        { module: "ghost", dist: null, distCandidates: [], file: "t/a.py", line: 5, lazy: false },
        { module: "celery", dist: null, distCandidates: [], file: "t/a.py", line: 9, lazy: true },
      ],
      declaredMissingModules: [
        { module: "pytest", dist: "pytest", group: "dev", files: 3, file: "t/a.py", line: 1, lazy: false },
      ],
    });
    // 预检只剩未声明的 ghost（pytest 已声明、celery 是 lazy）
    expect(dh.missingForFile(d, "t/a.py")).toEqual([
      { name: "ghost", line: 5, stmt: "import ghost" },
    ]);
    // lazy 提示也剔除已声明项
    expect(dh.lazyMissingForFile(d, "t/a.py")).toEqual([{ name: "celery", line: 9 }]);
  });

  it("uvRunSyncRisk：lock 过期 / requirements 未装 / E2 严重才提示，其余 null", () => {
    expect(dh.uvRunSyncRisk(null)).toBeNull();
    expect(dh.uvRunSyncRisk(fakeDiff())).toBeNull(); // 一切正常
    expect(dh.uvRunSyncRisk(fakeDiff({ lockOutOfDate: true }))).toContain("uv.lock 已过期");
    expect(dh.uvRunSyncRisk(fakeDiff({ requirementsUninstalled: true }))).toContain("requirements.txt 尚未安装");
    // E2 严重（≥ E2_SEVERE_COUNT 个声明依赖缺失）
    const severe = Array.from({ length: dh.E2_SEVERE_COUNT }, (_, i) => ({ dist: `p${i}`, spec: "" }));
    expect(dh.uvRunSyncRisk(fakeDiff({ declaredMissing: severe }))).toContain("未安装");
    // 低于阈值不提示（个别缺失属正常 E2 逐条表达，不构成隐式同步风险警告）
    expect(dh.uvRunSyncRisk(fakeDiff({ declaredMissing: severe.slice(0, dh.E2_SEVERE_COUNT - 1) }))).toBeNull();
  });
});

describe("打开工作区体检编排（§4.7）", () => {
  it("弹窗在前台时排队：模态关闭前 dep_scan 不发出（R13 弹窗优先）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_style") return { style: "pyproject", externalManager: null, requirementsFile: null };
      return fakeDiff();
    });
    // 前台模态（无 hidden = venv 确认/工具链引导在场）
    const modal = document.createElement("div");
    modal.className = "modal";
    document.body.appendChild(modal);

    const p = dh.runOpenWorkspaceCheck("F:/ws");
    await vi.advanceTimersByTimeAsync(5_000); // 越过 1.5s 延迟 + 多轮轮询
    expect(inv).toHaveBeenCalledWith("dep_style", { workspaceRoot: "F:/ws" });
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(false); // 仍在排队

    modal.classList.add("hidden"); // 用户完成决策，弹窗关闭
    await vi.advanceTimersByTimeAsync(dh.MODAL_POLL_MS + 50);
    await p;
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(true);
    expect(dh.latestDiff()).not.toBeNull();
    expect(outputEl.textContent).toContain("依赖体检");
  });

  it("无弹窗时按 1.5s 延迟启动并完成，摘要行落输出面板", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_style") return { style: "bare", externalManager: null, requirementsFile: null };
      return fakeDiff({ style: "bare", interpreter: null });
    });
    const p = dh.runOpenWorkspaceCheck("F:/ws");
    await vi.advanceTimersByTimeAsync(dh.OPEN_CHECK_DELAY_MS - 100);
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(false); // 延迟未到
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(outputEl.textContent).toContain("依赖体检：bare");
    expect(outputEl.textContent).toContain("未选解释器");
  });

  it("令牌丢弃：在途体检遇 resetDepHealth（切工作区）后结果不落地（§4.7 规则 4）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    let releaseScan: (v: DepDiff) => void = () => {};
    const scanGate = new Promise<DepDiff>((r) => (releaseScan = r));
    inv.mockImplementation((cmd: string) => {
      if (cmd === "dep_style") return Promise.resolve({ style: "pyproject", externalManager: null, requirementsFile: null });
      return scanGate; // dep_scan 悬挂，模拟慢扫描
    });

    const p = dh.runOpenWorkspaceCheck("F:/ws-old");
    await vi.advanceTimersByTimeAsync(dh.OPEN_CHECK_DELAY_MS + 100);
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(true); // 已发出，在途

    dh.resetDepHealth();       // 用户切换工作区
    releaseScan(fakeDiff());   // 旧工作区的扫描此刻才完成
    await p;

    expect(dh.latestDiff()).toBeNull();          // 旧结果被令牌丢弃
    expect(outputEl.textContent).toBe("");        // 不落摘要行（防旧数据污染新面板）
  });

  it("dep_scan 失败时留下 L0 事实行（不静默失败）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "dep_style") return { style: "external", externalManager: "poetry", requirementsFile: null };
      throw new Error("boom");
    });
    const p = dh.runOpenWorkspaceCheck("F:/ws");
    await vi.advanceTimersByTimeAsync(dh.OPEN_CHECK_DELAY_MS + 100);
    await p;
    expect(outputEl.textContent).toContain("external(poetry)");
    expect(outputEl.textContent).toContain("全量体检未完成");
  });
});

// ---------- M2 失效矩阵（§4.4 三层信号 / §5.5 环境信号自愈序列） ----------

describe("M2 sameSnapshot（§5.5 L1 真值判定）", () => {
  it("name==version 集合相等（顺序无关）；null 基线视为有差异", () => {
    const a = [{ name: "foo", version: "1.0" }];
    expect(dh.sameSnapshot(a, [{ name: "foo", version: "1.0" }])).toBe(true);
    expect(dh.sameSnapshot(a, [{ name: "foo", version: "2.0" }])).toBe(false); // 版本变了
    expect(dh.sameSnapshot(a, [])).toBe(false);                              // 卸包
    expect(dh.sameSnapshot(a, null)).toBe(false);                            // 无基线 → 有差异
    expect(dh.sameSnapshot([], [])).toBe(true);
    // 顺序无关
    const ab = [{ name: "a", version: "1" }, { name: "b", version: "2" }];
    const ba = [{ name: "b", version: "2" }, { name: "a", version: "1" }];
    expect(dh.sameSnapshot(ab, ba)).toBe(true);
  });
});

describe("M2 终端完成摘要嗅探（§4.4，命令 echo 不触发）", () => {
  beforeEach(() => {
    app.workspaceRoot = "F:/ws";
  });

  it("uv/pip 完成摘要 → 防抖 2s 后触发环境信号（dep_env_snapshot）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_env_snapshot") return [{ name: "foo", version: "1.0" }];
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.initDepHealth({ restartEngine: async () => {} });

    dh.sniffTerminalOutput("Installed 3 packages in 1.20s");
    // 防抖窗口内未触发
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS - 100);
    expect(inv.mock.calls.some((c) => c[0] === "dep_env_snapshot")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(inv).toHaveBeenCalledWith("dep_env_snapshot", { workspaceRoot: "F:/ws" });
  });

  it("pip 完成摘要（Successfully installed/uninstalled）同样触发", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_env_snapshot") return [];
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.initDepHealth({ restartEngine: async () => {} });
    dh.sniffTerminalOutput("Successfully installed numpy-1.26.0");
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(inv.mock.calls.some((c) => c[0] === "dep_env_snapshot")).toBe(true);
  });

  it("命令 echo（uv pip install / pip install）不触发（§9.2 误报控制）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_env_snapshot") return [];
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.initDepHealth({ restartEngine: async () => {} });
    dh.sniffTerminalOutput("uv pip install requests");
    dh.sniffTerminalOutput("pip install numpy");
    dh.sniffTerminalOutput("$ uv pip install -r requirements.txt");
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(inv.mock.calls.some((c) => c[0] === "dep_env_snapshot")).toBe(false);
  });

  it("跨块截断的完成行仍能命中（尾缓冲拼接）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_env_snapshot") return [];
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.initDepHealth({ restartEngine: async () => {} });
    dh.sniffTerminalOutput("Success");
    dh.sniffTerminalOutput("fully installed foo-1.0");
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(inv.mock.calls.some((c) => c[0] === "dep_env_snapshot")).toBe(true);
  });
});

describe("M2 环境信号自愈序列（§5.5：快照对比 → 有差异才级联）", () => {
  beforeEach(() => {
    app.workspaceRoot = "F:/ws";
  });

  it("快照有差异 → 重算 diff + restartEngine（反馈 3-4：红线消失）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    const restart = vi.fn().mockResolvedValue(undefined);
    let snap: Array<{ name: string; version: string }> = [{ name: "a", version: "1" }];
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_env_snapshot") return snap;
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.initDepHealth({ restartEngine: restart });

    // 首次信号：基线 null → 视为有差异 → 级联一次
    dh.scheduleEnvCheck();
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(true);

    // 环境真的变了（装了 b）→ 再次级联
    snap = [{ name: "a", version: "1" }, { name: "b", version: "2" }];
    dh.scheduleEnvCheck();
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("快照无差异 → 静默更新基线，不重算不重启（§5.5 步骤 3）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    const restart = vi.fn().mockResolvedValue(undefined);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_env_snapshot") return [{ name: "a", version: "1" }];
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.initDepHealth({ restartEngine: restart });

    // 首次：基线 null → 级联（建立基线）
    dh.scheduleEnvCheck();
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(restart).toHaveBeenCalledTimes(1);
    const scansAfterFirst = inv.mock.calls.filter((c) => c[0] === "dep_scan").length;

    // 第二次：快照相同 → 无差异 → 不级联
    dh.scheduleEnvCheck();
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(inv.mock.calls.filter((c) => c[0] === "dep_scan").length).toBe(scansAfterFirst);
  });

  it("dep_env_snapshot 失败 → 不级联（检测是顾问不是路障，§4.5 红线）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    const restart = vi.fn().mockResolvedValue(undefined);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_env_snapshot") throw new Error("uv 缺失");
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.initDepHealth({ restartEngine: restart });
    dh.scheduleEnvCheck();
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(restart).not.toHaveBeenCalled();
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(false);
  });
});

describe("M2 代码层/声明层失效信号（§4.4：防抖全量重算 + M4-2 scope 分流）", () => {
  beforeEach(() => {
    app.workspaceRoot = "F:/ws";
  });

  it(".py / 声明文件变更 → 防抖后 dep_scan（首扫 full：非 full 依赖后端缓存已建立）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.handleDepFsChanged([{ path: "src/main.py", kind: "py" }]);
    await vi.advanceTimersByTimeAsync(dh.FS_RESCAN_DEBOUNCE_MS - 100);
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(false); // 防抖窗口内
    await vi.advanceTimersByTimeAsync(200);
    expect(inv).toHaveBeenCalledWith("dep_scan", { workspaceRoot: "F:/ws", scope: "full" });
  });

  it("M4-2：已有快照后 .py 信号 → scope=code；声明信号 → scope=declaration；混合 → full", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    // 先建立快照（full 首扫）
    dh.handleDepFsChanged([{ path: "a.py", kind: "py" }]);
    await vi.advanceTimersByTimeAsync(dh.FS_RESCAN_DEBOUNCE_MS + 50);
    expect(inv).toHaveBeenCalledWith("dep_scan", { workspaceRoot: "F:/ws", scope: "full" });
    inv.mockClear();
    // .py 信号 → code（只重算代码层，跳过 L1/E5）
    dh.handleDepFsChanged([{ path: "b.py", kind: "py" }]);
    await vi.advanceTimersByTimeAsync(dh.FS_RESCAN_DEBOUNCE_MS + 50);
    expect(inv).toHaveBeenCalledWith("dep_scan", { workspaceRoot: "F:/ws", scope: "code" });
    inv.mockClear();
    // 声明信号 → declaration（重比环境快照，跳过探针）
    dh.handleDepFsChanged([{ path: "pyproject.toml", kind: "declaration" }]);
    await vi.advanceTimersByTimeAsync(dh.FS_RESCAN_DEBOUNCE_MS + 50);
    expect(inv).toHaveBeenCalledWith("dep_scan", { workspaceRoot: "F:/ws", scope: "declaration" });
    inv.mockClear();
    // 混合突发 → full（保守）
    dh.handleDepFsChanged([
      { path: "c.py", kind: "py" },
      { path: "uv.lock", kind: "declaration" },
    ]);
    await vi.advanceTimersByTimeAsync(dh.FS_RESCAN_DEBOUNCE_MS + 50);
    expect(inv).toHaveBeenCalledWith("dep_scan", { workspaceRoot: "F:/ws", scope: "full" });
  });

  it("声明文件（pyproject/requirements/uv.lock）同样触发重算", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.handleDepFsChanged([{ path: "pyproject.toml", kind: "declaration" }]);
    await vi.advanceTimersByTimeAsync(dh.FS_RESCAN_DEBOUNCE_MS + 50);
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(true);
  });

  it("other 类文件不触发重算（减噪）", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.handleDepFsChanged([{ path: "README.md", kind: "other" }]);
    await vi.advanceTimersByTimeAsync(dh.FS_RESCAN_DEBOUNCE_MS + 50);
    expect(inv.mock.calls.some((c) => c[0] === "dep_scan")).toBe(false);
  });

  it("防抖合并：窗口内多次变更只重算一次", async () => {
    vi.useFakeTimers();
    const { invoke } = await import("@tauri-apps/api/core");
    const inv = vi.mocked(invoke);
    inv.mockImplementation(async (cmd: string) => {
      if (cmd === "dep_scan") return fakeDiff();
      return undefined;
    });
    dh.handleDepFsChanged([{ path: "a.py", kind: "py" }]);
    dh.handleDepFsChanged([{ path: "b.py", kind: "py" }]);
    dh.handleDepFsChanged([{ path: "c.py", kind: "py" }]);
    await vi.advanceTimersByTimeAsync(dh.FS_RESCAN_DEBOUNCE_MS + 50);
    expect(inv.mock.calls.filter((c) => c[0] === "dep_scan").length).toBe(1);
  });
});

// ---------- M3：灯泡数据源（§6.3 depActionsForLine，光标行匹配 diff 定案） ----------

describe("M3 depActionsForLine（§6.3 灯泡 diff 数据源）", () => {
  const base = fakeDiff({
    missingInEnv: [
      { module: "yaml", dist: "PyYAML", distCandidates: ["PyYAML"], file: "a.py", line: 1, lazy: false },
      { module: "ghost", dist: null, distCandidates: [], file: "a.py", line: 2, lazy: false },
    ],
    undeclared: [{ module: "numpy", dist: "numpy", distCandidates: ["numpy"], file: "a.py", line: 3 }],
  });

  it("E1：dist 归一结果优先（不再依赖前端硬编码别名）", () => {
    const acts = dh.depActionsForLine(base, "a.py", "import yaml");
    expect(acts.length).toBe(1);
    expect(acts[0]).toMatchObject({ kind: "install", module: "yaml", spec: "PyYAML" });
    expect(acts[0].title).toContain("PyYAML");
    expect(acts[0].warning).toBeUndefined();
  });

  it("E1 dist=null：降级按模块名安装 + 警示可能装错包（§3.3 一级交互）", () => {
    const acts = dh.depActionsForLine(base, "a.py", "import ghost");
    expect(acts[0].spec).toBe("ghost");
    expect(acts[0].warning).toContain("可能装错包");
  });

  it("E4：已装未声明 → declare（安装并加入 pyproject）", () => {
    const acts = dh.depActionsForLine(base, "a.py", "import numpy");
    expect(acts.length).toBe(1);
    expect(acts[0].kind).toBe("declare");
    expect(acts[0].spec).toBe("numpy");
    expect(acts[0].title).toContain("加入 pyproject");
  });

  it("非 pyproject 项目不出 declare（E4 仅 pyproject 计算，与后端口径一致）", () => {
    const d = fakeDiff({
      style: "requirements",
      requirementsFile: "requirements.txt",
      undeclared: [{ module: "numpy", dist: "numpy", distCandidates: ["numpy"], file: "a.py", line: 3 }],
    });
    expect(dh.depActionsForLine(d, "a.py", "import numpy")).toEqual([]);
  });

  it("非 import 行 / 其他文件 / 无快照 → 空", () => {
    expect(dh.depActionsForLine(base, "a.py", "x = import_yaml")).toEqual([]);
    expect(dh.depActionsForLine(base, "a.py", "# import yaml")).toEqual([]);
    expect(dh.depActionsForLine(base, "b.py", "import yaml")).toEqual([]);
    expect(dh.depActionsForLine(null, "a.py", "import yaml")).toEqual([]);
  });

  it("from pkg.sub import x → 顶层模块 pkg；file 匹配大小写不敏感（Windows 口径）", () => {
    const d = fakeDiff({
      missingInEnv: [{ module: "pkg", dist: null, distCandidates: [], file: "Sub/A.py", line: 5, lazy: false }],
    });
    const acts = dh.depActionsForLine(d, "sub/a.py", "from pkg.sub import x");
    expect(acts.length).toBe(1);
    expect(acts[0].module).toBe("pkg");
  });
});

// ---------- M3：修复计划构建（§5.1 动作矩阵 → §5.3 批量预览） ----------

describe("M3 groupFixPlan（§5.1 动作矩阵）", () => {
  it("E1：dist 去重聚合；dist=null 附降级警示", () => {
    const d = fakeDiff({
      missingInEnv: [
        { module: "yaml", dist: "PyYAML", distCandidates: ["PyYAML"], file: "a.py", line: 1, lazy: false },
        { module: "yaml", dist: "PyYAML", distCandidates: ["PyYAML"], file: "b.py", line: 2, lazy: false }, // 跨文件同包去重
        { module: "ghost", dist: null, distCandidates: [], file: "b.py", line: 3, lazy: false },
      ],
    });
    const plan = dh.groupFixPlan(d, "e1")!;
    expect(plan.action).toBe("install");
    expect(plan.dists).toEqual(["PyYAML", "ghost"]);
    expect(plan.command).toBe("uv add PyYAML ghost"); // style=pyproject
    expect(plan.warning).toContain("可能装错包");
  });

  it("M4 复核修复 #3：多候选模块在组级批量计划 warning 中明示（首候选执行 + 行级另选指引）", () => {
    const d = fakeDiff({
      missingInEnv: [
        { module: "amb", dist: "pkg-a", distCandidates: ["pkg-a", "pkg-b"], file: "a.py", line: 1, lazy: false },
      ],
      undeclared: [
        { module: "uamb", dist: "u-a", distCandidates: ["u-a", "u-b"], file: "a.py", line: 2 },
      ],
    });
    const e1 = dh.groupFixPlan(d, "e1")!;
    expect(e1.dists).toEqual(["pkg-a"]);
    expect(e1.warning).toContain("amb");
    expect(e1.warning).toContain("首个候选");
    expect(e1.warning).toContain("行级");
    const e4 = dh.groupFixPlan(d, "e4")!;
    expect(e4.warning).toContain("uamb");
    // 单候选不追加多候选提示（不 noisy）
    const single = fakeDiff({
      missingInEnv: [{ module: "yaml", dist: "PyYAML", distCandidates: ["PyYAML"], file: "a.py", line: 1, lazy: false }],
    });
    expect(dh.groupFixPlan(single, "e1")!.warning).toBeUndefined();
  });

  it("E2：pyproject → uv sync + 破坏性警示（§5.1 脚注 1）；requirements → pip install -r", () => {
    const py = fakeDiff({ declaredMissing: [{ dist: "flask", spec: ">=3" }] });
    const plan = dh.groupFixPlan(py, "e2")!;
    expect(plan.command).toBe("uv sync");
    expect(plan.warning).toContain("移除环境中未声明的包");
    const req = fakeDiff({
      style: "requirements",
      requirementsFile: "requirements.txt",
      declaredMissing: [{ dist: "flask", spec: "" }],
    });
    expect(dh.groupFixPlan(req, "e2")!.command).toBe("uv pip install -r requirements.txt");
    expect(dh.groupFixPlan(req, "e2")!.warning).toBeUndefined(); // -r 安装非破坏性
  });

  it("E3：仅 pyproject 可写声明；requirements/bare → null（收敛路径是迁移）", () => {
    const py = fakeDiff({ envDrift: [{ dist: "numpy", version: "2.0" }] });
    const plan = dh.groupFixPlan(py, "e3")!;
    expect(plan.command).toBe("uv add numpy==2.0");
    expect(plan.note).toContain("已安装版本"); // 锁定语义说明随计划附带
    const bare = fakeDiff({ style: "bare", envDrift: [{ dist: "numpy", version: "2.0" }] });
    expect(dh.groupFixPlan(bare, "e3")).toBeNull();
  });

  it("E3：version 为空 → 退化裸 dist（不生成“numpy==”）且不附带锁定说明", () => {
    const noVer = fakeDiff({ envDrift: [{ dist: "requests", version: "" }] });
    const plan = dh.groupFixPlan(noVer, "e3")!;
    expect(plan.command).toBe("uv add requests");
    expect(plan.note).toBeUndefined();
  });

  it("E5 / migrate：lock 过期才出计划；migrate 仅 requirements 且注明不改原文件（R4.1）", () => {
    expect(dh.groupFixPlan(fakeDiff(), "e5")).toBeNull();
    expect(dh.groupFixPlan(fakeDiff({ lockOutOfDate: true }), "e5")!.command).toBe("uv lock");
    const req = fakeDiff({ style: "requirements", requirementsFile: "requirements.txt" });
    const mig = dh.groupFixPlan(req, "migrate")!;
    expect(mig.action).toBe("migrate");
    expect(mig.command).toBe("uv add -r requirements.txt");
    expect(mig.warning).toContain("不改写原 requirements.txt");
    expect(dh.groupFixPlan(fakeDiff(), "migrate")).toBeNull();
  });

  it("空组不出计划（面板不渲染修复按钮）", () => {
    const d = fakeDiff();
    expect(dh.groupFixPlan(d, "e1")).toBeNull();
    expect(dh.groupFixPlan(d, "e2")).toBeNull();
    expect(dh.groupFixPlan(d, "e3")).toBeNull();
    expect(dh.groupFixPlan(d, "e4")).toBeNull();
  });
});

// ---------- M3：命令预览折叠（§5.3 批量预览呈现口径） ----------

describe("M3 previewFixCommand（§5.3 批量预览折叠）", () => {
  it("dist 列表过长折叠中段，包名总数如实呈现", () => {
    expect(dh.previewFixCommand({ action: "declare", dists: ["a", "b", "c", "d", "e"], command: "uv add a b c d e" }))
      .toBe("uv add a b c …（其余 2 个）");
  });

  it("dist 数不超过上限（3）原样返回，不折叠", () => {
    expect(dh.previewFixCommand({ action: "install", dists: ["x", "y"], command: "uv pip install x y" }))
      .toBe("uv pip install x y");
  });

  it("sync / migrate 无 dist 列表，恒原样返回", () => {
    expect(dh.previewFixCommand({ action: "sync", dists: [], command: "uv sync" })).toBe("uv sync");
    expect(dh.previewFixCommand({ action: "migrate", dists: [], command: "uv add -r requirements.txt" }))
      .toBe("uv add -r requirements.txt");
  });
});

// ---------- M3：修复执行编排（§5.6 L3 交互 + §5.2 收尾协议） ----------

describe("M3 runDepFix（§5.6 L3 交互 + §5.2 收尾协议完整性）", () => {
  let calls: string[];

  beforeEach(() => {
    app.workspaceRoot = "F:/ws";
    calls = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "dep_fix") return 0;
      if (cmd === "dep_scan") return fakeDiff();
      if (cmd === "dep_env_snapshot") return [];
      return undefined as never;
    });
  });

  const plan = (over: Partial<Parameters<typeof dh.runDepFix>[0][number]> = {}) =>
    ({ action: "install", dists: ["x"], command: "uv pip install x", ...over }) as never;

  it("note（非破坏性说明）进确认文案且不触发 danger 按钮（kind=primary）", async () => {
    dh.initDepHealth({ restartEngine: async () => {} });
    vi.mocked(openConfirm).mockResolvedValue(true);
    await dh.runDepFix(
      [plan({ action: "declare", dists: ["numpy==2.0"], command: "uv add numpy==2.0", note: "将按当前已安装版本锁定写入声明" })],
      "写入漂移包到声明",
    );
    const opts = vi.mocked(openConfirm).mock.calls[0][0];
    expect(opts.message).toContain("将按当前已安装版本锁定写入声明");
    expect(opts.message).toContain("uv add numpy==2.0");
    expect(opts.kind).toBe("primary"); // note 非破坏性，不升级为 danger
  });

  it("批量 dists 超过批次上限 → 拆成多批逐批 dep_fix（#1 防一条命令全有或全无）", async () => {
    dh.initDepHealth({ restartEngine: async () => {} });
    vi.mocked(openConfirm).mockResolvedValue(true);
    const seen: string[][] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push(cmd);
      if (cmd === "dep_fix") { seen.push((args as { dists?: string[] })?.dists ?? []); return 0; }
      if (cmd === "dep_scan") return fakeDiff();
      if (cmd === "dep_env_snapshot") return [];
      return undefined as never;
    });
    const dists = Array.from({ length: dh.DEP_FIX_BATCH_SIZE + 5 }, (_, i) => `pkg${i}`);
    await dh.runDepFix(
      [plan({ action: "declare", dists, command: `uv add ${dists.join(" ")}` })],
      "写入漂移包到声明",
    );
    expect(seen.length).toBe(2); // 20 + 5 两批，而非一条 25 个的命令
    expect(seen[0]).toHaveLength(dh.DEP_FIX_BATCH_SIZE);
    expect(seen[1]).toHaveLength(5);
  });

  it("确认拒绝 → dep_fix 不执行、无收尾（R5：全部显式确认，无静默写）", async () => {
    vi.mocked(openConfirm).mockResolvedValue(false);
    const ok = await dh.runDepFix([plan()], "安装包");
    expect(ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("成功：dep_fix → 收尾协议三步按序（重算 diff → 基线 → restartEngine）→ success toast", async () => {
    vi.mocked(openConfirm).mockResolvedValue(true);
    const restart = vi.fn(async () => { calls.push("restartEngine"); });
    dh.initDepHealth({ restartEngine: restart });
    const ok = await dh.runDepFix([plan()], "安装包");
    expect(ok).toBe(true);
    expect(calls).toEqual(["dep_fix", "dep_scan", "dep_env_snapshot", "restartEngine"]);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("修复完成"), "success");
    expect(toastFail).not.toHaveBeenCalled();
    // 确认弹窗内容含命令预览与联网告知（§5.6-1）
    const opts = vi.mocked(openConfirm).mock.calls[0][0];
    expect(opts.message).toContain("uv pip install x");
    expect(opts.message).toContain("需联网");
  });

  it("失败即停：首条 exit≠0 → 第二条不执行 + toastFail + 半态仍重算（§5.6-5）", async () => {
    vi.mocked(openConfirm).mockResolvedValue(true);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "dep_fix") return 1; // 非零退出
      if (cmd === "dep_scan") return fakeDiff();
      if (cmd === "dep_env_snapshot") return [];
      return undefined as never;
    });
    dh.initDepHealth({ restartEngine: async () => { calls.push("restartEngine"); } });
    const ok = await dh.runDepFix([plan({ dists: ["a"] }), plan({ dists: ["b"] })], "安装包");
    expect(ok).toBe(false);
    expect(calls.filter((c) => c === "dep_fix").length).toBe(1); // 第二条没跑
    expect(calls).toContain("dep_scan");                          // 半态环境如实重算
    expect(toastFail).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("修复完成"), "success");
  });

  it("dep_fix 抛异常 → toastFail + 收尾仍执行（诊断不留 stale）", async () => {
    vi.mocked(openConfirm).mockResolvedValue(true);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "dep_fix") throw new Error("uv 不存在");
      if (cmd === "dep_scan") return fakeDiff();
      if (cmd === "dep_env_snapshot") return [];
      return undefined as never;
    });
    dh.initDepHealth({ restartEngine: async () => { calls.push("restartEngine"); } });
    const ok = await dh.runDepFix([plan()], "安装包");
    expect(ok).toBe(false);
    expect(toastFail).toHaveBeenCalled();
    expect(calls).toContain("dep_scan");
    expect(dh.depFixBusy()).toBe(false); // finally 复位（防卡死）
  });

  it("防重入：dep_fix 在途时第二次触发被前端拒（§5.6-3，后端互斥锁的另一半）", async () => {
    vi.mocked(openConfirm).mockResolvedValue(true);
    let releaseFix: (v: number) => void = () => {};
    const fixGate = new Promise<number>((r) => (releaseFix = r));
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === "dep_fix") return fixGate as Promise<never>;
      if (cmd === "dep_scan") return Promise.resolve(fakeDiff()) as Promise<never>;
      if (cmd === "dep_env_snapshot") return Promise.resolve([]) as Promise<never>;
      return Promise.resolve(undefined) as Promise<never>;
    });
    dh.initDepHealth({ restartEngine: async () => {} });
    const first = dh.runDepFix([plan({ action: "lock", dists: [], command: "uv lock" })], "刷新锁");
    await new Promise((r) => setTimeout(r, 0)); // 让 first 进入 dep_fix 在途窗口
    expect(dh.depFixBusy()).toBe(true);
    const second = await dh.runDepFix([plan({ action: "lock", dists: [], command: "uv lock" })], "刷新锁");
    expect(second).toBe(false);
    expect(calls.filter((c) => c === "dep_fix").length).toBe(1);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("正在执行"), "info");
    releaseFix(0);
    await first;
    expect(dh.depFixBusy()).toBe(false);
  });
});

// ---------- M3：异常触达 toast（§4.7 / §5.5 步骤 2，会话去重） ----------

describe("M3 异常触达 toast（会话去重，venvPrompted 模式推广）", () => {
  beforeEach(() => {
    app.workspaceRoot = "F:/ws";
  });

  it("issueCount：E 组计数 + lock 过期；requirementsUninstalled 不重复计数", () => {
    expect(dh.issueCount(fakeDiff())).toBe(0);
    expect(dh.issueCount(fakeDiff({
      missingInEnv: [{ module: "x", dist: null, distCandidates: [], file: "a.py", line: 1, lazy: false }],
      lockOutOfDate: true,
    }))).toBe(2);
    expect(dh.issueCount(fakeDiff({ requirementsUninstalled: true }))).toBe(0);
  });

  it("notifyEnvDriftOnce：非空 → toast 带「查看」；同状态去重；数字变化/reset 后可再提示", () => {
    const d = fakeDiff({ envDrift: [{ dist: "numpy", version: "2.0" }] });
    dh.notifyEnvDriftOnce("F:/ws", d);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0][2]).toMatchObject({ actionLabel: "查看" });
    dh.notifyEnvDriftOnce("F:/ws", d); // 同状态 → 去重
    expect(toast).toHaveBeenCalledTimes(1);
    dh.notifyEnvDriftOnce("F:/ws", fakeDiff({
      envDrift: [{ dist: "a", version: "1" }, { dist: "b", version: "2" }],
    })); // 漂移数变化 = 新状态
    expect(toast).toHaveBeenCalledTimes(2);
    dh.resetDepHealth(); // 换工作区复位去重集
    dh.notifyEnvDriftOnce("F:/ws", d);
    expect(toast).toHaveBeenCalledTimes(3);
  });

  it("envDrift 为空不提示", () => {
    dh.notifyEnvDriftOnce("F:/ws", fakeDiff());
    expect(toast).not.toHaveBeenCalled();
  });

  it("环境信号有漂移 → 级联重算后 toast「环境与声明不一致」（§5.5 步骤 2 全链路）", async () => {
    vi.useFakeTimers();
    const restart = vi.fn().mockResolvedValue(undefined);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "dep_env_snapshot") return [{ name: "numpy", version: "2.0" }];
      if (cmd === "dep_scan") return fakeDiff({ envDrift: [{ dist: "numpy", version: "2.0" }] });
      return undefined;
    });
    dh.initDepHealth({ restartEngine: restart });
    dh.scheduleEnvCheck();
    await vi.advanceTimersByTimeAsync(dh.ENV_CHECK_DEBOUNCE_MS + 50);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("个包未声明"), "info", expect.objectContaining({ actionLabel: "查看" }),
    );
  });
});

// ---------- M4：惰性导入提示（M4-1，纯输出面板 hint + 会话去重语义由调用方承担） ----------

describe("M4 lazy 提示辅助（§3.3 lazy 字段 / M4-1 定案：纯输出面板）", () => {
  it("lazyMissingForFile：只取该文件 lazy 条目、按行排序", () => {
    const d = fakeDiff({
      missingInEnv: [
        { module: "pandas", dist: null, distCandidates: [], file: "sub/a.py", line: 9, lazy: false },
        { module: "scipy", dist: null, distCandidates: [], file: "sub/a.py", line: 20, lazy: true },
        { module: "celery", dist: null, distCandidates: [], file: "sub/a.py", line: 5, lazy: true },
        { module: "other", dist: null, distCandidates: [], file: "b.py", line: 1, lazy: true },
      ],
    });
    expect(dh.lazyMissingForFile(d, "sub/a.py")).toEqual([
      { name: "celery", line: 5 },
      { name: "scipy", line: 20 },
    ]);
  });

  it("lazyHintLine：空 → null；非空 → 文案含模块与行号 + 明示不阻塞", () => {
    expect(dh.lazyHintLine([])).toBeNull();
    const line = dh.lazyHintLine([{ name: "scrapy", line: 20 }, { name: "celery", line: 5 }]);
    expect(line).toContain("2 个惰性导入");
    expect(line).toContain("不阻塞");
    expect(line).toContain("scrapy L20");
    expect(line).toContain("celery L5");
  });
});

// ---------- M4-3：traceback ModuleNotFoundError → 一键安装 ----------

describe("M4 traceback ModuleNotFoundError 检测（§6.4）", () => {
  beforeEach(() => {
    app.workspaceRoot = "F:/ws";
  });

  it("命中 → toast error +「安装」按钮；同模块会话去重；reset 后可再提示", () => {
    const install = vi.fn();
    dh.setDepInstallHandler(install);
    const hit = dh.handleTracebackLine("ModuleNotFoundError: No module named 'fastapi'");
    expect(hit).toBe(true);
    expect(toast).toHaveBeenCalledTimes(1);
    const [msg, kind, opts] = vi.mocked(toast).mock.calls[0];
    expect(msg).toContain("fastapi");
    expect(kind).toBe("error");
    expect(opts?.actionLabel).toBe("安装");
    // 动作按钮触发安装（toast mock 不渲染真实按钮，直接调 onAction 验证接线）
    opts?.onAction?.();
    expect(install).toHaveBeenCalledWith("fastapi");
    // 同模块去重
    dh.handleTracebackLine("Traceback (most recent call last): ModuleNotFoundError: No module named 'fastapi'");
    expect(toast).toHaveBeenCalledTimes(1);
    // reset 后可再提示（换工作区）
    dh.resetDepHealth();
    dh.handleTracebackLine("ModuleNotFoundError: No module named 'fastapi'");
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("子模块取顶层（a.b.c → a）；非 ModuleNotFoundError 行不命中", () => {
    expect(dh.handleTracebackLine("ModuleNotFoundError: No module named 'pkg.sub.mod'")).toBe(true);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0][0]).toContain("pkg");
    expect(dh.handleTracebackLine("ImportError: cannot import name 'x'")).toBe(false);
    expect(dh.handleTracebackLine("ModuleNotFoundError: No module named x")).toBe(false); // 需引号包裹
    expect(toast).toHaveBeenCalledTimes(1); // 无新增
  });
});

// ---------- M4-4：dist 歧义候选选择 ----------

describe("M4 resolveDistForInstall（同 module 多 dist 候选）", () => {
  it("空/单候选直接返回不弹窗", async () => {
    expect(await dh.resolveDistForInstall("x", [])).toBeNull();
    expect(await dh.resolveDistForInstall("x", ["only"])).toBe("only");
    expect(await dh.resolveDistForInstall("x", ["", "  "])).toBeNull(); // 空白过滤
  });

  it("两候选 → openChoice：ok=首候选 / neutral=次候选 / cancel=null", async () => {
    const { openChoice } = await import("../dialog");
    const mocked = vi.mocked(openChoice);
    mocked.mockReset();
    mocked.mockResolvedValueOnce("ok");
    expect(await dh.resolveDistForInstall("amb", ["pkg-a", "pkg-b"])).toBe("pkg-a");
    mocked.mockResolvedValueOnce("neutral");
    expect(await dh.resolveDistForInstall("amb", ["pkg-a", "pkg-b"])).toBe("pkg-b");
    mocked.mockResolvedValueOnce("cancel");
    expect(await dh.resolveDistForInstall("amb", ["pkg-a", "pkg-b"])).toBeNull();
    expect(mocked.mock.calls[0][0].okLabel).toContain("pkg-a");
    expect(mocked.mock.calls[0][0].neutralLabel).toContain("pkg-b");
  });

  it("超两候选：列出全部 + 其余提示手动安装（仍只提供前两个按钮）", async () => {
    const { openChoice } = await import("../dialog");
    const mocked = vi.mocked(openChoice);
    mocked.mockReset();
    mocked.mockResolvedValueOnce("ok");
    expect(await dh.resolveDistForInstall("amb", ["a", "b", "c", "d"])).toBe("a");
    const opts = mocked.mock.calls[0][0];
    expect(opts.message).toContain("3. c");
    expect(opts.message).toContain("手动安装");
  });
});
