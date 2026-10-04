// v3.4 §11（M3-3.8）：运行历史按实例归属采集的单测。
// 多实例并行时各写各的快照（脚本 / 项目 / 项目 2）；退出码与 exitKind 随 term-exit 落档；
// 超限保留尾部；Pin 豁免淘汰。
import { beforeEach, describe, expect, it } from "vitest";
import {
  finishRunRecord, listRuns, recordRunLines, removeRun, resetRunHistory,
  startRunRecord, togglePin,
} from "../runHistory";

beforeEach(() => {
  resetRunHistory();
});

describe("按实例归属的运行历史（§11 / §17-8）", () => {
  it("startRunRecord 按实例登记；recordRunLines 剥离后按行入档到对应实例", () => {
    startRunRecord("run-term-script", { kind: "script", path: "/ws/main.py", label: "运行 · main.py", selection: null });
    startRunRecord("run-term-project-1", { kind: "project", path: "project:uvicorn", label: "项目", selection: null });
    recordRunLines("run-term-script", "hello\nworld\n");
    recordRunLines("run-term-project-1", "uvicorn starting\n");
    const runs = listRuns();
    expect(runs).toHaveLength(2);
    const script = runs.find((r) => r.instanceId === "run-term-script")!;
    const project = runs.find((r) => r.instanceId === "run-term-project-1")!;
    expect(script.lines.map((l) => l.text)).toEqual(["hello", "world"]);
    expect(project.lines.map((l) => l.text)).toEqual(["uvicorn starting"]);
  });

  it("finishRunRecord 落退出码与原因；同实例重跑时旧记录自动收尾", () => {
    startRunRecord("run-term-script", { kind: "script", path: "/ws/main.py", label: "运行", selection: null });
    recordRunLines("run-term-script", "out\n");
    finishRunRecord("run-term-script", 0, "code");
    const r = listRuns()[0];
    expect(r.code).toBe(0);
    expect(r.exitKind).toBe("code");
    expect(r.finishedAt).not.toBeNull();
    // 同实例重跑：旧记录（已 finish）保留在档，新记录接管活跃位
    startRunRecord("run-term-script", { kind: "script", path: "/ws/main.py", label: "运行", selection: null });
    const runs = listRuns();
    expect(runs).toHaveLength(2);
    // 倒序：第一条是新的活跃记录（finishedAt=null），第二条是旧的已完结记录
    expect(runs[0].finishedAt).toBeNull();
    expect(runs[0].code).toBeNull();
    expect(runs[1].code).toBe(0);
    expect(runs[1].finishedAt).not.toBeNull();
  });

  it("停止 / 取消的退出原因入档（exitKind）", () => {
    startRunRecord("run-term-project-1", { kind: "project", path: "project:app", label: "项目", selection: null });
    finishRunRecord("run-term-project-1", null, "stopped");
    expect(listRuns()[0].exitKind).toBe("stopped");
  });

  it("半行缓冲：跨 chunk 的行拼接后再入档，块尾无换行不产生残行（复查回归钉）", () => {
    startRunRecord("run-term-script", { kind: "script", path: "/ws/main.py", label: "运行", selection: null });
    recordRunLines("run-term-script", "Uvicorn run");
    recordRunLines("run-term-script", "ning on http://127.0.0.1:8000\nINFO:app star");
    recordRunLines("run-term-script", "ted\n");
    const r = listRuns()[0];
    expect(r.lines.map((l) => l.text)).toEqual([
      "Uvicorn running on http://127.0.0.1:8000",
      "INFO:app started",
    ]);
  });

  it("finishRunRecord 冲刷残留半行（进程退出前的无换行尾行不丢失）", () => {
    startRunRecord("run-term-script", { kind: "script", path: "/ws/main.py", label: "运行", selection: null });
    recordRunLines("run-term-script", "done\nfinal partial");
    finishRunRecord("run-term-script", 0, "code");
    const r = listRuns()[0];
    expect(r.lines.map((l) => l.text)).toEqual(["done", "final partial"]);
  });

  it("超限保留尾部（MAX_LINES_PER_RUN=3000，报错总在最后）", () => {
    startRunRecord("run-term-script", { kind: "script", path: "/ws/main.py", label: "运行", selection: null });
    for (let i = 0; i < 3050; i++) {
      recordRunLines("run-term-script", `line-${i}\n`);
    }
    const r = listRuns()[0];
    expect(r.lines).toHaveLength(3000);
    expect(r.lines[0].text).toBe("line-50");
    expect(r.lines[2999].text).toBe("line-3049");
  });

  it("Pin 豁免淘汰（MAX_RUNS=20）；removeRun 删除指定记录", () => {
    for (let i = 0; i < 22; i++) {
      startRunRecord(`run-term-project-${i + 1}`, { kind: "project", path: "project:x", label: `项目 ${i + 1}`, selection: null });
      finishRunRecord(`run-term-project-${i + 1}`, 0, "code");
    }
    expect(listRuns().length).toBeLessThanOrEqual(20);
    // Pin 的记录不被淘汰
    const pinnedId = listRuns()[0].id;
    togglePin(pinnedId);
    for (let i = 100; i < 125; i++) {
      startRunRecord(`run-term-p-${i}`, { kind: "project", path: "project:y", label: `P${i}`, selection: null });
      finishRunRecord(`run-term-p-${i}`, 0, "code");
    }
    expect(listRuns().some((r) => r.id === pinnedId)).toBe(true);
    // removeRun 后消失
    removeRun(pinnedId);
    expect(listRuns().some((r) => r.id === pinnedId)).toBe(false);
  });

  it("同一实例 id 反复运行也受 MAX_RUNS 上限约束（脚本覆盖语义回归钉，§11）", () => {
    // 脚本运行恒用 run-term-script：instanceId 复用时，淘汰判据若归一为 instanceId 会失效，
    // 导致纯脚本场景历史无界增长（回归钉）。
    for (let i = 0; i < 25; i++) {
      startRunRecord("run-term-script", { kind: "script", path: "/ws/main.py", label: "运行", selection: null });
      finishRunRecord("run-term-script", 0, "code");
    }
    expect(listRuns().length).toBeLessThanOrEqual(20);
  });
});
