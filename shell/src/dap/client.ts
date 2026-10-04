// DAP 桥 TS 侧（docs/python_debug_dev_plan.md §6.3）：DAP 事件订阅、请求封装、会话状态机。
// Rust 侧（src-tauri/src/dap.rs）持有 TCP 连接并转发帧；本模块只做协议关联与状态分发，
// 与 lsp/client.ts 对称（id 自增 + Promise 表匹配响应 + 事件回调注册）。

import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { app } from "../state"; // B-3：justMyCode 开关真值（state 零依赖，无环）
import { t } from "../i18n"; // 第十六批 i18n：DAP 错误文案走语言包

// ---------- 类型（DAP MVP 子集，§5.3） ----------

/** DAP 消息（Rust 侧原样转发的 JSON 帧） */
export interface DapMessage {
  seq?: number;
  type?: string; // "request" | "response" | "event"
  // request
  command?: string;
  arguments?: unknown;
  // response
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
  // event
  event?: string;
  // rust 侧附带的关联 id（dap_send_request 的入参 id，响应匹配用）
  id?: number;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: { path?: string; name?: string };
  line: number;
  column: number;
}

export interface DapScope {
  name: string;
  presentationHint?: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface DapThread {
  id: number;
  name: string;
}

/** DAP `evaluate` 的响应（P1：求值表达式 / 调试控制台） */
export interface DapEvaluateResult {
  /** 求值结果的字符串表示（可直接展示） */
  result: string;
  /** 值类型（debugpy 给出 repr 的类型名，可选） */
  type?: string;
  /** 非 0 = 该值可继续展开（在 variables 里查子项） */
  variablesReference: number;
}

export type DebugPhase = "idle" | "starting" | "running" | "stopped" | "exited";

// ---------- 断点规格（P0：条件断点 / 命中断点 / Logpoint） ----------
//
// 三个字段都是 DAP `SourceBreakpoint` 的**原生字段**（D2/D3），debugpy 完整支持：
// - condition    ：表达式为真才断下（Python 表达式，在断点所在帧求值）；
// - hitCondition ：命中次数条件，形如 "5" / ">3" / "%2==0"（DAP 规范为次数表达式）；
// - logMessage   ：**不打停**，只把 {expr} 插值后打印到调试控制台（Logpoint）。
// Rust 侧 `dap_send_request` 把 params 作为 serde_json::Value 原样转发（无白名单），
// 故新增字段无需改动 dap.rs——协议桥是纯透传的。

/** 单个断点的高级属性（全空 = 普通断点） */
export interface BreakpointSpec {
  /** 条件表达式（空 = 无条件） */
  condition?: string;
  /** 命中次数条件（空 = 每次都断） */
  hitCondition?: string;
  /** 日志消息（非空 = Logpoint，不断下只打印） */
  logMessage?: string;
  /** 启用状态（B-6；缺省 = 启用。禁用的断点**不下发** debugger，gutter/面板显示灰点） */
  enabled?: boolean;
}

/** 推送给 debugpy 的断点项（line + 可选高级字段） */
export interface DapSourceBreakpoint extends BreakpointSpec {
  line: number;
}

/** 断点类型（UI 渲染/排序用） */
export type BreakpointKind = "plain" | "condition" | "log";

// ---------- 会话状态（§6.5 状态机） ----------

let phase: DebugPhase = "idle";
const phaseListeners: Array<(p: DebugPhase) => void> = [];

// P1-11（2026-09-29 review）：会话身份——旧会话清理线程的 debug-exited（stop → 快速
// 重启场景）无身份标识时会把新会话的 pending 全拒 + phase 踩成 exited。Rust 侧的
// debug-started / debug-exited 事件均携带会话 seq；本会话 seq 在收到 debug-started 时
// 记录，迟到的旧事件（seq 不匹配 / 本会话尚未 started）直接忽略。
let sessionSeq: number | null = null;

/** P1-13：在 runDebug 首个 await 前同步置 starting（门控提前），失败路径由调用方复位。 */
export function markStarting(): void {
  sessionSeq = null;
  setPhase("starting");
}

export function onPhase(fn: (p: DebugPhase) => void): void {
  phaseListeners.push(fn);
  fn(phase);
}

export function currentPhase(): DebugPhase {
  return phase;
}

function setPhase(p: DebugPhase): void {
  phase = p;
  for (const fn of phaseListeners) fn(p);
}

// ---------- 异常断点（B-2） ----------
//
// debugpy 的 exceptionFilters："uncaught"（未捕获才停，默认开）/"raised"（一抛就停，默认关）。
// 用户选择跨会话保留（resetDebugState 不重置）——排查偶发崩溃的开关不该每次重调。

let exceptionFilters: string[] = ["uncaught"];

export function getExceptionFilters(): string[] {
  return [...exceptionFilters];
}

/** 更新异常断点过滤器：配置阶段缓存，运行/暂停中即时下发（DAP 支持会话中途修改） */
export async function setExceptionFilters(filters: string[]): Promise<void> {
  exceptionFilters = filters;
  if (phase === "running" || phase === "stopped") {
    await request("setExceptionBreakpoints", { filters });
  }
}

// ---------- 当前帧访问器（B-8：hover 求值需要帧上下文） ----------
//
// 帧真值在 debugView（栈顶/用户点击切换），这里只存镜像供 lsp hover 等只读消费方取用——
// lsp/client.ts 不能 import debugView（会成环），dap 是两者共同的下游。

let activeFrame: number | null = null;

export function setActiveFrameId(id: number | null): void {
  activeFrame = id;
}

export function getActiveFrameId(): number | null {
  return activeFrame;
}

// ---------- 请求关联（id 自增 + Promise 表） ----------

// P2-3（2026-09-29 review）：单序号域——原实现有 nextRequestId（pending 表键）与
// nextMsgSeq（实际出站 seq）两个计数器，响应按 request_seq（= msgSeq）查以 id 为键
// 的表，两者数值恒等纯属「每次请求各自 +1」的巧合。任何路径单独消耗其一（只发消息
// 不建 pending 或反之）都会让全部响应静默错配。删掉 nextMsgSeq，id 直接作出站 seq
// （Rust 侧 dap_send_request 的出站 seq 设计，debugpy 以 request_seq 回显）。
let nextRequestId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();

/** 请求超时（ms）：正常 DAP 请求远小于此；debugpy 慢启动给足余量 */
const DAP_REQUEST_TIMEOUT_MS = 15_000;

function settlePending(id: number, fn: (p: { resolve: (v: any) => void; reject: (e: any) => void }) => void): void {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  fn(p);
}

/** 发送 DAP 请求，返回 Promise（响应按 request_seq 关联；id 即出站 seq，单序号域） */
export function request(command: string, arguments_: unknown): Promise<any> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settlePending(id, (p) => p.reject(new Error(t("debug.dap.requestTimeout", { seconds: DAP_REQUEST_TIMEOUT_MS / 1000, command }))));
    }, DAP_REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    invoke("dap_send_request", { id, method: command, params: arguments_ ?? {} }).catch((e) => {
      settlePending(id, (p) => p.reject(e));
    });
  });
}

// ---------- 事件分发 ----------

const eventHandlers = new Map<string, (body: any) => void>();

/** 注册 DAP 事件回调（stopped / continued / output / terminated / exited / initialized） */
export function onEvent(event: string, fn: (body: any) => void): void {
  eventHandlers.set(event, fn);
}

// ---------- 生命周期 ----------

let unlistenMessage: UnlistenFn | null = null;
let unlistenExited: UnlistenFn | null = null;
let unlistenStarted: UnlistenFn | null = null;

/** 销毁 DAP 事件监听（与 lsp/client.ts disposeListeners 同语义：测试 teardown / 多窗口场景用） */
export function disposeDapListeners(): void {
  unlistenMessage?.();
  unlistenExited?.();
  unlistenStarted?.();
  unlistenMessage = null;
  unlistenExited = null;
  unlistenStarted = null;
}

/** 事件监听（幂等：只挂一次）。main.ts 启动时调用。 */
export async function wireDapEvents(): Promise<void> {
  if (unlistenMessage) return;

  unlistenMessage = await getCurrentWindow().listen<DapMessage>("dap-message", (e) => {
    const msg = e.payload;
    if (msg.type === "response") {
      // 响应：按 Rust 侧回传的 request_seq（= 我们发请求时的 msgSeq）关联
      const reqId = msg.request_seq ?? -1;
      settlePending(reqId, (p) => {
        if (msg.success === false) {
          p.reject(new Error(msg.message ?? t("debug.dap.requestFailed", { command: msg.command ?? "" })));
        } else {
          p.resolve(msg.body);
        }
      });
    } else if (msg.type === "event" && msg.event) {
      // phase 状态机由事件驱动（§6.5）：stopped → "stopped"；continued → "running"；
      // terminated 由后端 debug-exited 收尾（此处不重复置 exited，避免与清场竞态）。
      if (msg.event === "stopped" && phase !== "idle") setPhase("stopped");
      else if (msg.event === "continued" && phase !== "idle") setPhase("running");
      const h = eventHandlers.get(msg.event);
      h?.(msg.body ?? {});
    }
  });

  // 会话结束（debug_stop / debugpy 自然退出 / 崩溃）：拒绝全部 pending + 状态机复位。
  // P1-11：Rust 侧事件携带会话 seq（debug-exited payload.seq）——与本会话 seq 比对，
  // 不匹配说明是旧会话的迟到事件（stop → 快速 F5 重启场景），新会话不受影响。
  // 本会话尚未收到 debug-started（sessionSeq=null）时也忽略（starting 早段的迟到事件）。
  unlistenExited = await getCurrentWindow().listen<{ reason: string; seq?: number }>("debug-exited", (e) => {
    const evSeq = e.payload?.seq;
    if (typeof evSeq === "number") {
      if (sessionSeq === null || evSeq !== sessionSeq) return; // 旧会话迟到事件
    }
    const err = new Error(t("debug.dap.sessionEnded"));
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    setPhase("exited");
  });

  unlistenStarted = await getCurrentWindow().listen<{ port: number; pid: number | null; seq?: number }>("debug-started", (e) => {
    // P1-11：记录本会话身份（Rust 侧会话 seq），后续 debug-exited 按此比对。
    if (typeof e.payload?.seq === "number") {
      sessionSeq = e.payload.seq;
    }
    setPhase("starting");
  });
}

/**
 * 启动调试会话（stdio adapter 架构，2026-09-10 实测修订）。
 *
 * 时序（全部经真实 debugpy 验证）：
 *   debug_start（Rust spawn stdio adapter）
 *   → initialize
 *   → attach {"listen":{"host":"127.0.0.1","port":0}}（走「server 主动连入」路径，
 *     同时清空 adapter access_token，debuggee 无需鉴权）
 *   → 收 debugpyWaitingForServer {host, port} 事件（adapter 的 server socket 地址）
 *   → debug_attach_debuggee（Rust 在 PTY 里 spawn --connect 的被调试脚本）
 *   → 收 initialized 事件（debuggee 的 pydevd 连入后触发）
 *   → setBreakpoints（回调注入）→ configurationDone → 脚本开始执行
 *
 * 历史教训（v1 设计为何废弃，见 dap.rs 文件头）：--listen 模式在 ConPTY 下
 * debugpy 内部 spawn adapter 不工作（应用内 30s 连不上）；stdio adapter 把
 * adapter 的生命周期移到 Rust 手里，PTY 里只跑被调试脚本本身。
 */
export async function startDebug(
  path: string,
  workspaceRoot: string | null,
  pushBreakpoints: () => Promise<void>,
): Promise<void> {
  await wireDapEvents();
  // markStarting 已在 runDebug 侧提前调用（P1-13）；此处兜底（直调 startDebug 的测试 /
  // 其他调用方）：sessionSeq 清空 + 置 starting。
  sessionSeq = null;
  setPhase("starting");
  await invoke("debug_start", { path, workspaceRoot });

  // initialize 握手
  await request("initialize", {
    clientID: "pylume",
    clientName: "Pylume",
    adapterID: "debugpy",
    locale: "en",
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: "path",
    supportsVariableType: true,
    supportsRunInTerminalRequest: false,
  });

  // attach（listen 模式）：响应推迟到 configurationDone，发出后不等；
  // 随后 adapter 发 debugpyWaitingForServer 事件携带 server socket 地址。
  // B-3：justMyCode 从设置读取（默认开 = 只步进我的代码，不误入 site-packages），
  // 改动需重启调试会话生效。
  request("attach", {
    listen: { host: "127.0.0.1", port: 0 },
    justMyCode: app.settings.debug_just_my_code !== false,
  }).catch(() => undefined);

  // 等 debugpyWaitingForServer（server socket 地址）→ 在 PTY 里拉起被调试脚本
  const serverEp = await waitEvent("debugpyWaitingForServer", 30_000);
  const host: string = serverEp?.host ?? "127.0.0.1";
  const port: number = serverEp?.port ?? 0;
  await invoke("debug_attach_debuggee", { path, workspaceRoot, host, port });

  // 等 initialized（debuggee 的 pydevd 连入 adapter 后发出；此后才允许配置）
  await waitInitialized();

  // 推送断点（全部文件，见 §6.4）
  await pushBreakpoints();

  // B-2：异常断点（configurationDone 前配置；运行/暂停中可经 setExceptionFilters 随时改）
  await request("setExceptionBreakpoints", { filters: exceptionFilters });

  // configurationDone ← 此后脚本开始执行（attach 的响应也在此时回来）
  await request("configurationDone", {});
  setPhase("running");
}

/** 等指定事件一次（携带 body resolve；超时 reject） */
function waitEvent(event: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventHandlers.delete(event);
      reject(new Error(t("debug.dap.waitEventTimeout", { event })));
    }, timeoutMs);
    eventHandlers.set(event, (body: any) => {
      clearTimeout(timer);
      eventHandlers.delete(event);
      resolve(body);
    });
  });
}

/** 等 initialized 事件（启动时序用；超时 30s：debuggee 连入受系统繁忙影响） */
function waitInitialized(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventHandlers.delete("initialized");
      reject(new Error(t("debug.dap.waitInitializedTimeout")));
    }, 30_000);
    eventHandlers.set("initialized", () => {
      clearTimeout(timer);
      eventHandlers.delete("initialized");
      resolve();
    });
  });
}

/** 停止调试会话（Rust 侧杀进程树 + 清理） */
export async function stopDebug(): Promise<void> {
  try {
    await invoke("debug_stop");
  } catch { /* 未启动时忽略 */ }
}

// ---------- DAP 请求封装（MVP 子集，§5.3） ----------

export async function dapThreads(): Promise<DapThread[]> {
  const body = await request("threads", {});
  return body?.threads ?? [];
}

export async function dapStackTrace(threadId: number): Promise<DapStackFrame[]> {
  const body = await request("stackTrace", { threadId });
  return body?.stackFrames ?? [];
}

export async function dapScopes(frameId: number): Promise<DapScope[]> {
  const body = await request("scopes", { frameId });
  return body?.scopes ?? [];
}

export async function dapVariables(variablesReference: number): Promise<DapVariable[]> {
  const body = await request("variables", { variablesReference });
  return body?.variables ?? [];
}

/**
 * 设置单文件断点（§6.4 + P0 条件断点/Logpoint）。
 * params = { source: { path }, breakpoints: [{ line, condition?, hitCondition?, logMessage? }] }
 * 只带非空字段——全空字段显式传 null 会让部分适配器把断点判为「不可用」。
 */
export async function dapSetBreakpoints(path: string, bps: DapSourceBreakpoint[]): Promise<any> {
  return request("setBreakpoints", {
    source: { path },
    // B-6：禁用的断点不下发（gutter 保留灰点，启用时重新 sync）
    breakpoints: bps
      .filter((b) => b.enabled !== false)
      .map((b) => {
      const out: Record<string, unknown> = { line: b.line };
      if (b.condition) out.condition = b.condition;
      if (b.hitCondition) out.hitCondition = b.hitCondition;
      if (b.logMessage) out.logMessage = b.logMessage;
      return out;
    }),
  });
}

/**
 * 求值表达式（P1，PyCharm Alt+F8 / Debug Console 的协议基础）。
 *
 * `frameId` 省略时 debugpy 用**当前选中帧**；显式传入可固定到某一帧（切换栈帧后求值）。
 * `context` 取 "repl" —— 语义即「像在解释器里敲这行」，副作用会真实发生
 * （这是 Debug Console 与 hover 求值的分水岭，后者用 "hover" 且应无副作用）。
 */
export async function dapEvaluate(
  expression: string,
  frameId?: number | null,
  context: "repl" | "watch" | "hover" | "clipboard" = "repl",
): Promise<DapEvaluateResult> {
  const args: Record<string, unknown> = { expression, context };
  if (frameId !== undefined && frameId !== null) args.frameId = frameId;
  const body = await request("evaluate", args);
  return {
    result: body?.result ?? "",
    type: body?.type,
    variablesReference: body?.variablesReference ?? 0,
  };
}

/**
 * 改写变量值（P1 · DAP `setVariable`）。
 * `variablesReference` 为变量所在容器（locals / globals scope 的引用），不是变量自身。
 */
export async function dapSetVariable(
  variablesReference: number,
  name: string,
  value: string,
): Promise<DapVariable> {
  const body = await request("setVariable", { variablesReference, name, value });
  return {
    name: body?.name ?? name,
    value: body?.value ?? "",
    type: body?.type,
    variablesReference: body?.variablesReference ?? 0,
  };
}

/** 步进控制（§1.1）：继续 / 单步跳过 / 单步进入 / 单步退出 / 暂停 */
export async function dapContinue(threadId: number): Promise<void> {
  await request("continue", { threadId });
  setPhase("running");
}

export async function dapNext(threadId: number): Promise<void> {
  await request("next", { threadId });
}

export async function dapStepIn(threadId: number): Promise<void> {
  await request("stepIn", { threadId });
}

export async function dapStepOut(threadId: number): Promise<void> {
  await request("stepOut", { threadId });
}

/** 状态复位（debug-exited 后 UI 清场用；不触碰后端）。P1-11：同时清会话身份。 */
export function resetDebugState(): void {
  sessionSeq = null;
  setPhase("idle");
}
