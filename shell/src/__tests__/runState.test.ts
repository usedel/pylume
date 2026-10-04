// TD-14 ① + v3.4 §17-4（M3-3.3）：多实例运行列表 + 运行配置归一化口径的单测。
// RunState 从单实例判别联合改为**运行实例列表**（kind/id/label/phase/startedAt）；
// isRunning() = 任一实例在跑；⏹ 与 tab 停止按钮按实例 id 路由。纯模块（零 DOM 依赖）。

import { describe, expect, it, beforeEach } from "vitest";
import {
  EMPTY_RUN_CONFIG, addRunInstance, clearRunInstances, findRunInstance, isRunning,
  latestActiveInstance, listRunInstances, normalizeRunConfig, projectRunActive,
  removeRunInstance, resetRunStateAll, runningPathsOf, scriptRunActive, selectionMetaOf,
  type RunInstance,
} from "../runState";

function inst(partial: Partial<RunInstance> & Pick<RunInstance, "id" | "kind">): RunInstance {
  return {
    label: "运行",
    phase: "running",
    startedAt: Date.now(),
    path: null,
    selection: null,
    exit: null,
    canceled: false,
    stopping: false,
    ...partial,
  };
}

describe("normalizeRunConfig（与后端 RunProfile serde default 同口径）", () => {
  it("缺字段一律回落缺省", () => {
    const cfg = normalizeRunConfig(undefined);
    expect(cfg).toEqual(EMPTY_RUN_CONFIG);
  });

  it("未知 entry.kind 回落 script；module 原样保留", () => {
    expect(normalizeRunConfig({ entry: { kind: "bogus" as "script", target: "x" } }).entry.kind).toBe("script");
    expect(normalizeRunConfig({ entry: { kind: "module", target: "uvicorn" } }).entry).toEqual({
      kind: "module",
      target: "uvicorn",
    });
  });

  it("v2 遗留字段（name/stdin/allow_multiple 等）被静默丢弃，不进归一化结果（§4.3）", () => {
    const cfg = normalizeRunConfig({
      name: "legacy",
      stdin: { mode: "file", path: "in.txt" },
      allow_multiple: true,
      auto_rerun: true,
      python_console: true,
      args: "--x",
    } as unknown as Parameters<typeof normalizeRunConfig>[0]);
    expect(cfg).toEqual({ ...EMPTY_RUN_CONFIG, args: "--x" });
    expect("stdin" in cfg).toBe(false);
    expect("name" in cfg).toBe(false);
  });
});

describe("多实例运行列表（§17-4 / §12）", () => {
  beforeEach(() => resetRunStateAll());

  it("空列表：isRunning 为假，无实例可查", () => {
    expect(isRunning()).toBe(false);
    expect(listRunInstances()).toEqual([]);
    expect(findRunInstance("run-term-script")).toBeNull();
    expect(latestActiveInstance()).toBeNull();
  });

  it("脚本实例：登记后 isRunning / scriptRunActive 为真，path 进 runningPathsOf", () => {
    addRunInstance(inst({ id: "run-term-script", kind: "script", path: "/ws/main.py" }));
    expect(isRunning()).toBe(true);
    expect(scriptRunActive()).toBe(true);
    expect(projectRunActive()).toBe(false);
    expect(runningPathsOf().has("/ws/main.py")).toBe(true);
    expect(findRunInstance("run-term-script")?.kind).toBe("script");
  });

  it("项目实例与脚本实例并存（§12 不互斥）：各自独立、isRunning 覆盖两者", () => {
    addRunInstance(inst({ id: "run-term-script", kind: "script", path: "/ws/main.py" }));
    addRunInstance(inst({ id: "run-term-project-1", kind: "project", label: "项目" }));
    addRunInstance(inst({ id: "run-term-project-2", kind: "project", label: "项目 2" }));
    expect(listRunInstances()).toHaveLength(3);
    expect(scriptRunActive()).toBe(true);
    expect(projectRunActive()).toBe(true);
  });

  it("exited 不算在跑（§7.3）：退出后的实例不再驱动 isRunning / ⏹", () => {
    addRunInstance(inst({ id: "run-term-script", kind: "script", phase: "exited", exit: { kind: "code", code: 0 } }));
    expect(isRunning()).toBe(false);
    expect(scriptRunActive()).toBe(false);
    expect(latestActiveInstance()).toBeNull();
  });

  it("⏹ 停止路由取最近启动且在跑的（§10：只停一个）", () => {
    const t0 = Date.now() - 5000;
    addRunInstance(inst({ id: "run-term-script", kind: "script", startedAt: t0 }));
    addRunInstance(inst({ id: "run-term-project-1", kind: "project", startedAt: t0 + 1000 }));
    addRunInstance(inst({ id: "run-term-project-2", kind: "project", startedAt: t0 + 2000 }));
    expect(latestActiveInstance()?.id).toBe("run-term-project-2");
  });

  it("⏹ 停止路由不含 preparing 实例（§7.3：preparing 态 ⏹ 置灰——进程未落地无处着力，复查回归钉）", () => {
    const t0 = Date.now() - 5000;
    // 仅一个 preparing 实例（无 running）→ ⏹ 无目标
    addRunInstance(inst({ id: "run-term-script", kind: "script", phase: "preparing", startedAt: t0 }));
    expect(latestActiveInstance()).toBeNull();
    // preparing（晚启动）与 running（早启动）并存 → 取 running 的
    addRunInstance(inst({ id: "run-term-project-1", kind: "project", phase: "running", startedAt: t0 - 1000 }));
    expect(latestActiveInstance()?.id).toBe("run-term-project-1");
  });

  it("移除实例（关闭 tab）：removeRunInstance 幂等，clearRunInstances 清全部（§15）", () => {
    addRunInstance(inst({ id: "run-term-script", kind: "script" }));
    addRunInstance(inst({ id: "run-term-project-1", kind: "project" }));
    removeRunInstance("run-term-script");
    removeRunInstance("run-term-script"); // 幂等
    expect(listRunInstances()).toHaveLength(1);
    clearRunInstances();
    expect(listRunInstances()).toHaveLength(0);
  });

  it("选区运行：selection 元信息按临时文件路径查找（traceback 映射）", () => {
    const sel = { tempPath: "/ws/__pylume_selection__abc.py", sourcePath: "/ws/main.py", startLine: 12 };
    addRunInstance(inst({ id: "run-term-script", kind: "script", path: sel.tempPath, selection: sel }));
    expect(selectionMetaOf(sel.tempPath)).toEqual(sel);
    expect(selectionMetaOf("/ws/other.py")).toBeNull();
  });
});
