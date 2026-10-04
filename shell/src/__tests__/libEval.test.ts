// libEval 单测（库特别支持 PR-1 验收 §3.3）：防抖 / LRU / stale / 强制求值 / 四态错误码分流。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core"; // mocked（vi.mock 工厂）
import {
  classifyInvokeError,
  createEvalController,
  evalKind,
  EvalCache,
  type EvalResult,
} from "../libEval";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** 默认 invoke：按 Rust 输出协议返回 ok 单行 */
function mockOk(data: unknown = { n: 1 }): void {
  vi.mocked(invoke).mockResolvedValue(JSON.stringify({ ok: true, data }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const ROOT = { workspaceRoot: () => "F:/ws" };

describe("evalKind", () => {
  it("ok：解析协议 data 字段", async () => {
    mockOk({ matches: [1, 2] });
    const res = await evalKind<{ matches: number[] }>("regex_test", { pattern: "a" }, { workspaceRoot: "F:/ws" });
    expect(res.state).toBe("ok");
    expect(res.data).toEqual({ matches: [1, 2] });
    expect(invoke).toHaveBeenCalledWith("py_eval", {
      workspaceRoot: "F:/ws",
      kind: "regex_test",
      argsJson: JSON.stringify({ pattern: "a" }),
    });
  });

  it("err：脚本级 ok:false 原文透传", async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({ ok: false, error: "re.error: missing ), unterminated subpattern" }));
    const res = await evalKind("regex_test", {}, { workspaceRoot: "F:/ws" });
    expect(res.state).toBe("err");
    expect(res.error).toContain("re.error");
  });

  it("timeout / noInterpreter：按 Rust 错误码前缀分流", async () => {
    vi.mocked(invoke).mockRejectedValue("Timeout: 命令执行超时（3s）");
    expect((await evalKind("regex_test", {}, { workspaceRoot: "F:/ws" })).state).toBe("timeout");
    vi.mocked(invoke).mockRejectedValue("NoInterpreter: uv python find 未找到可用解释器");
    expect((await evalKind("regex_test", {}, { workspaceRoot: "F:/ws" })).state).toBe("noInterpreter");
    // 其余前缀（ScriptError / BadKind）归 err
    vi.mocked(invoke).mockRejectedValue("ScriptError: args_json 不是合法 JSON");
    expect((await evalKind("regex_test", {}, { workspaceRoot: "F:/ws" })).state).toBe("err");
  });

  it("classifyInvokeError 兜底非字符串异常", () => {
    expect(classifyInvokeError(new Error("boom")).state).toBe("err");
    expect(classifyInvokeError(42).state).toBe("err");
  });
});

describe("createEvalController 防抖", () => {
  it("窗口内重复调用只触发一次 IPC，结果统一返回", async () => {
    mockOk({ n: 1 });
    const c = createEvalController<{ n: number }>("regex_test", ROOT);
    const p1 = c.request({ pattern: "a" });
    const p2 = c.request({ pattern: "a" });
    const p3 = c.request({ pattern: "a" });
    await vi.advanceTimersByTimeAsync(200);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(r1.data).toEqual({ n: 1 });
    expect(r2.data).toEqual({ n: 1 });
    expect(r3.data).toEqual({ n: 1 });
  });

  it("窗口尾部以最后一次 args 求值", async () => {
    mockOk();
    const c = createEvalController("regex_test", ROOT);
    void c.request({ pattern: "first" });
    void c.request({ pattern: "last" });
    await vi.advanceTimersByTimeAsync(200);
    const callArgs = vi.mocked(invoke).mock.calls[0]![1] as { argsJson: string };
    expect(callArgs.argsJson).toBe(JSON.stringify({ pattern: "last" }));
  });
});

describe("createEvalController LRU", () => {
  it("相同 args 命中缓存（不重复 IPC）；不同 args miss", async () => {
    mockOk({ hit: true });
    const c = createEvalController<{ hit: boolean }>("regex_test", ROOT);
    // force 立即求值并写缓存；后续等值 request 命中缓存不再 IPC
    const first = await c.force({ pattern: "a" });
    const second = await c.request({ pattern: "a" });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(second.data).toEqual(first.data);
    await c.force({ pattern: "b" });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
  });

  it("缓存容量 100：超出后淘汰最旧（get 刷新最近使用）", () => {
    const cache = new EvalCache<unknown>();
    for (let i = 0; i <= 100; i++) cache.set(`k${i}`, { state: "ok" }); // 101 个 → k0 被淘汰
    expect(cache.get("k0")).toBeUndefined();
    expect(cache.get("k1")).toBeDefined();
    // get("k1") 刷新最近使用后，新 set 淘汰的是次旧的 k2 而非 k1
    cache.set("k101", { state: "ok" });
    expect(cache.get("k1")).toBeDefined();
    expect(cache.get("k2")).toBeUndefined();
  });
});

describe("createEvalController stale", () => {
  it("后发强制求值令先发在途结果作 stale", async () => {
    // release 队列：第 i 次 invoke 的 resolve 存在第 i 位
    const releases: Array<(v: string) => void> = [];
    vi.mocked(invoke).mockImplementation(
      () => new Promise<string>((resolve) => releases.push(resolve)),
    );
    const c = createEvalController<{ v: number }>("regex_test", ROOT);
    const p1 = c.request({ pattern: "a" });
    await vi.advanceTimersByTimeAsync(200); // 防抖窗口过 → IPC1 挂起
    const p2 = c.force({ pattern: "b" }); // IPC2 挂起（token 更新为 2）
    // 强制求值先返回（v=2），被超越的 IPC1 后返回（v=1）→ stale
    releases[1]!(JSON.stringify({ ok: true, data: { v: 2 } }));
    releases[0]!(JSON.stringify({ ok: true, data: { v: 1 } }));
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.stale).toBe(true);
    expect(r1.data).toEqual({ v: 1 });
    expect(r2.stale).toBeUndefined();
    expect(r2.data).toEqual({ v: 2 });
  });

  it("cancel：未启动的防抖调用得到 idle（不发 IPC）；在途调用结果作 stale", async () => {
    const releases: Array<(v: string) => void> = [];
    vi.mocked(invoke).mockImplementation(
      () => new Promise<string>((resolve) => releases.push(resolve)),
    );
    const c = createEvalController<{ v: number }>("regex_test", ROOT);
    // 未启动：防抖窗口内取消 → idle，IPC 未发出
    const pUnstarted = c.request({ pattern: "a" });
    c.cancel();
    expect(await pUnstarted).toEqual({ state: "idle" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    // 在途：IPC 已发出后取消 → 迟到结果带 stale 交给调用方（面板据此丢弃渲染）
    const pInflight = c.request({ pattern: "b" });
    await vi.advanceTimersByTimeAsync(200); // IPC 已发出
    c.cancel();
    releases[0]!(JSON.stringify({ ok: true, data: { v: 1 } }));
    const r: EvalResult<{ v: number }> = await pInflight;
    expect(r.stale).toBe(true);
    expect(c.getState()).toBe("idle");
    // 取消期间的结果不写缓存：等值 request 会重新 IPC
    vi.mocked(invoke).mockReset();
    mockOk();
    const p2 = c.request({ pattern: "b" });
    await vi.advanceTimersByTimeAsync(200);
    await p2;
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });
});

describe("createEvalController 强制求值", () => {
  it("force 跳过防抖与缓存", async () => {
    mockOk({ forced: true });
    const c = createEvalController<{ forced: boolean }>("regex_test", ROOT);
    const res = await c.force({ pattern: "x" });
    expect(res.data).toEqual({ forced: true });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    // force 结果也进缓存（等值 request 不再 IPC）
    await c.request({ pattern: "x" });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });
});

describe("createEvalController 无工作区", () => {
  it("未打开工作区直接返回 noInterpreter，不发 IPC", async () => {
    const c = createEvalController("regex_test", { workspaceRoot: () => null });
    const res = await c.force({ pattern: "a" });
    expect(res.state).toBe("noInterpreter");
    expect(invoke).not.toHaveBeenCalled();
  });
});
