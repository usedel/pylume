// Python 求值桥前端 helper（库特别支持 PR-1，docs/python_library_support_dev_plan.md §3.2）。
// 通用纪律 §2-5：**求值统一走本模块**——自带 200ms 防抖（探针 P1 定案）+ LRU(100) 结果缓存 +
// stale 标志 + `force()` 供 Ctrl+Enter 强制求值 + 四态错误码分流；各面板禁止自己写 invoke("py_eval")。
// 纯 TS、无 DOM 依赖（可单测；UI 态由面板按 EvalResult.state 渲染）。

import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n"; // 第十八批 i18n：库文案走语言包

// ---------- 类型 ----------

/** 四态错误码（Rust 侧 lib_cmds 错误码前缀）+ UI 基础态 */
export type EvalState = "idle" | "pending" | "ok" | "err" | "timeout" | "noInterpreter";

export interface EvalResult<T = unknown> {
  state: EvalState;
  /** state==="ok" 时的脚本产出（受控脚本 data 字段） */
  data?: T;
  /** 失败详情：err = 脚本级错误原文（如 re.error）；timeout / noInterpreter 为基建态文案 */
  error?: string;
  /** 结果已被更新的求值超越（面板应丢弃本次渲染） */
  stale?: boolean;
}

export interface EvalKindOptions {
  workspaceRoot: string;
}

export interface EvalControllerOptions {
  /** 工作区根动态读取（控制器生命周期长于单次求值） */
  workspaceRoot: () => string | null;
  /** 防抖窗口毫秒数（默认 200ms） */
  debounceMs?: number;
}

export interface EvalController<T = unknown> {
  /** 防抖求值：窗口内重复调用只触发最后一次 IPC；命中 LRU 缓存立即返回 */
  request(args: unknown): Promise<EvalResult<T>>;
  /** 强制求值（Ctrl+Enter）：跳过防抖与缓存 */
  force(args: unknown): Promise<EvalResult<T>>;
  /** 当前状态（由最近一次非 stale 求值推进） */
  getState(): EvalState;
  /** 丢弃挂起的防抖并令在途结果作 stale（面板关闭 / 输入清空） */
  cancel(): void;
  /** 清空 LRU 缓存（测试 / 工作区切换） */
  clearCache(): void;
}

// ---------- 常量 ----------

const DEBOUNCE_MS = 200;
const LRU_MAX = 100;

// ---------- 单次求值 ----------

/** invoke 拒绝错误 → 四态分流（Rust 错误码前缀：Timeout: / NoInterpreter: / ScriptError: / BadKind:） */
export function classifyInvokeError(e: unknown): EvalResult<never> {
  const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (msg.startsWith("Timeout:")) return { state: "timeout", error: msg.slice("Timeout:".length).trim() || t("devtools.eval.timeoutFallback") };
  if (msg.startsWith("NoInterpreter:")) {
    return { state: "noInterpreter", error: msg.slice("NoInterpreter:".length).trim() || t("devtools.eval.noInterpreterFallback") };
  }
  return { state: "err", error: msg };
}

/**
 * 单次受控脚本求值：`invoke("py_eval")` + 输出协议解析。
 * 返回 EvalResult（永 reject——错误一律进 state，调用方免 try/catch）。
 */
export async function evalKind<T = unknown>(
  kind: string,
  args: unknown,
  opts: EvalKindOptions,
): Promise<EvalResult<T>> {
  let payload: string;
  try {
    payload = JSON.stringify(args ?? {});
  } catch (e) {
    return { state: "err", error: t("devtools.eval.argsSerializeFailed", { msg: String(e) }) };
  }
  try {
    const line = await invoke<string>("py_eval", {
      workspaceRoot: opts.workspaceRoot,
      kind,
      argsJson: payload,
    });
    const parsed = JSON.parse(line) as { ok: boolean; data?: T; error?: string };
    if (parsed.ok) return { state: "ok", data: parsed.data as T };
    return { state: "err", error: parsed.error ?? t("devtools.eval.unknownScriptError") };
  } catch (e) {
    return classifyInvokeError(e);
  }
}

// ---------- 控制器（防抖 + LRU + stale） ----------

/** 缓存键：稳定序列化（键序无关）；序列化失败（循环引用等）返回 null = 不走缓存 */
function stableKey(args: unknown): string | null {
  try {
    return JSON.stringify(args, (_k, v) =>
      v instanceof Object && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
        : v,
    );
  } catch {
    return null;
  }
}

/** LRU(100) 结果缓存：get 重插尾部，set 超限淘汰头部 */
export class EvalCache<T> {
  private map = new Map<string, EvalResult<T>>();

  get(key: string): EvalResult<T> | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: EvalResult<T>): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > LRU_MAX) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export function createEvalController<T = unknown>(
  kind: string,
  opts: EvalControllerOptions,
): EvalController<T> {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestToken = 0;
  let state: EvalState = "idle";
  const cache = new EvalCache<T>();
  /** 防抖窗口内挂起的 promise resolver（窗口结束时统一 resolve 最新结果） */
  let pendingResolvers: Array<(r: EvalResult<T>) => void> = [];

  async function run(args: unknown): Promise<EvalResult<T>> {
    const root = opts.workspaceRoot();
    if (!root) return { state: "noInterpreter", error: t("devtools.eval.noWorkspace") };
    const myToken = ++latestToken;
    state = "pending";
    const res = await evalKind<T>(kind, args, { workspaceRoot: root });
    if (myToken !== latestToken) return { ...res, stale: true };
    state = res.state;
    return res;
  }

  function resolvePending(res: EvalResult<T>): void {
    const resolvers = pendingResolvers;
    pendingResolvers = [];
    for (const r of resolvers) r(res);
  }

  function request(args: unknown): Promise<EvalResult<T>> {
    // 命中缓存立即返回（缓存只存终态结果，重放不推进 stale）
    const key = stableKey(args);
    if (key !== null) {
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
    }
    if (timer !== null) clearTimeout(timer);
    return new Promise<EvalResult<T>>((resolve) => {
      pendingResolvers.push(resolve);
      timer = setTimeout(() => {
        timer = null;
        // 窗口结束：resolver 归属本次 run（此后新来的 force/cancel 不再替它们回填）
        const resolvers = pendingResolvers;
        pendingResolvers = [];
        run(args).then((res) => {
          if (!res.stale && key !== null) cache.set(key, res);
          for (const r of resolvers) r(res);
        });
      }, debounceMs);
    });
  }

  function force(args: unknown): Promise<EvalResult<T>> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const key = stableKey(args);
    return run(args).then((res) => {
      if (!res.stale && key !== null) cache.set(key, res);
      resolvePending(res); // 强制求值 = 最新意图：释放防抖窗口内挂起的调用方
      return res;
    });
  }

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    latestToken++; // 在途结果作 stale
    state = "idle";
    resolvePending({ state: "idle" });
  }

  return {
    request,
    force,
    getState: () => state,
    cancel,
    clearCache: () => cache.clear(),
  };
}
