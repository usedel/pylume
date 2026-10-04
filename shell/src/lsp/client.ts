// LSP 桥 TS 侧：JSON-RPC 关联 + Monaco providers（ADR-0003）
// Rust 侧（src-tauri/src/lsp.rs）spawn 引擎进程并转发帧；本模块只做协议关联与 provider 注册。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { STDLIB_MODULES } from "../stdlib";
import { app } from "../state";
import * as dap from "../dap/client"; // B-8：暂停态 hover 求值（dap 不依赖 lsp，无环）
import { depActionsForLine, latestDiff, toWorkspaceRelative } from "../depHealth";
import { isSuppressedEngineAction } from "../quickFix";
import { t } from "../i18n"; // i18n 复核修复：hover 调试段与 quickfix 标题走语言包
import { libsHoverAt } from "../dslLens"; // 库支持 PR-2/PR-3（R-1）：hover 合并管线的自研追加段

// Monaco 实例注入（配合 main.ts 动态加载；providers 注册前必须先注入）
let monaco: typeof MonacoApi;
export function setMonaco(m: typeof MonacoApi): void {
  monaco = m;
  buildKindMap();
}

// ---------- 类型 ----------

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspLocation { uri: string; range: LspRange }
interface LspDiagnostic { range: LspRange; severity?: number; message: string; source?: string; code?: string | number }

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  insertTextFormat?: number; // 1 = plain, 2 = snippet
  sortText?: string;
  filterText?: string;
  data?: unknown; // 引擎用于 completionItem/resolve 标识的不透明数据
  labelDetails?: { detail?: string; description?: string };
  additionalTextEdits?: Array<{ range: LspRange; newText: string }>;
}

interface LspHover { contents: unknown }

export type EngineStatus = "off" | "starting" | "ready" | "error" | "exited";

// ---------- JSON-RPC 关联 ----------

let nextRequestId = 1;

/** 引擎会话：每个引擎实例独立 pending 与状态（"static" = pyrefly/basedpyright，"intel" = pylume-intel）。 */
interface EngineSession {
  engine: string;
  status: EngineStatus;
  /** CR-11：pending 条目带超时句柄，settle 时 clearTimeout + delete，杜绝无界泄漏 */
  pending: Map<number, {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}
const sessions = new Map<string, EngineSession>();

function session(engine: string): EngineSession {
  let s = sessions.get(engine);
  if (!s) {
    s = { engine, status: "off", pending: new Map() };
    sessions.set(engine, s);
  }
  return s;
}

/** pending 条目 settle（resolve 或 reject 都走这里）：清定时器 + 删条目，幂等 */
function settlePending(s: EngineSession, id: number, fn: (p: { resolve: (v: any) => void; reject: (e: any) => void }) => void): void {
  const p = s.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  s.pending.delete(id);
  fn(p);
}

const notificationHandlers = new Map<string, (params: any, engine?: string) => void>();
let unlistenMessage: UnlistenFn | null = null;
let unlistenExit: UnlistenFn | null = null;
let unlistenStderr: UnlistenFn | null = null;

// 静态引擎状态（UI 展示用；intel 状态只影响补全/hover/definition 合并，不主导 UI）
let engineStatus: EngineStatus = "off";
const engineStatusListeners: Array<(s: EngineStatus) => void> = [];

export function onEngineStatus(fn: (s: EngineStatus) => void): void {
  engineStatusListeners.push(fn);
  fn(engineStatus);
}

/** E-2：同步读当前引擎状态（findUsages 等 UI 判断「引擎未就绪 → 结果可能不完整」用） */
export function getEngineStatus(): EngineStatus {
  return engineStatus;
}
function setEngineStatus(s: EngineStatus): void {
  engineStatus = s;
  for (const fn of engineStatusListeners) fn(s);
}

export function onNotification(method: string, fn: (params: any, engine?: string) => void): void {
  notificationHandlers.set(method, fn);
}

/** 发送 LSP 请求到静态引擎（默认），返回 Promise */
export function request(method: string, params: unknown): Promise<any> {
  return requestEngine("static", method, params);
}

/** CR-11：请求超时（ms）。默认覆盖 pyrefly 大仓库首索引的慢请求；initialize 走更长时限。 */
const REQUEST_TIMEOUT_MS = 15_000;
const INITIALIZE_TIMEOUT_MS = 60_000;

/** 发送 LSP 请求到指定引擎 */
export function requestEngine(engine: string, method: string, params: unknown): Promise<any> {
  const s = session(engine);
  const id = nextRequestId++;
  const timeout = method === "initialize" ? INITIALIZE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // CR-11：引擎假死（丢帧/内部死锁）时 Promise 永不 settle，闭包与 pending 条目无界泄漏，
    // 补全 widget 永久转圈。超时 reject 兜底；响应到达时 settlePending 清定时器。
    const timer = setTimeout(() => {
      settlePending(s, id, (p) => p.reject(new Error(t("ide.lsp.requestTimeout", { sec: timeout / 1000, method }))));
    }, timeout);
    s.pending.set(id, { resolve, reject, timer });
    invoke("lsp_send_request", { engine, id, method, params }).catch((e) => {
      // CR-11：invoke 失败（IPC 层）也要删条目，否则泄漏且超时定时器空转
      settlePending(s, id, (p) => p.reject(e));
    });
  });
}

/** 发送 LSP 通知到静态引擎（默认） */
export function notify(method: string, params: unknown): Promise<void> {
  return notifyEngine("static", method, params);
}

/** 发送 LSP 通知到指定引擎 */
export function notifyEngine(engine: string, method: string, params: unknown): Promise<void> {
  return invoke("lsp_send_notification", { engine, method, params }).then(undefined, (e) => {
    console.error(e);
  });
}

/** CR-23：intel 处于 "starting"（加载 trace DB 可达数秒）时，用户新打开文件的 didOpen
 * 被 broadcast 过滤丢弃 → intel 永不知道该文件，运行时补全/hover/inlay 失效直到重启。
 * 对 starting 引擎排队，ready 时冲刷。 */
const startingQueues = new Map<string, Array<{ method: string; params: unknown }>>();

/** 通知广播给所有就绪引擎（文档同步类方法：didOpen/didChange/didClose/didSave）。
 * CR-23：starting 引擎入队而非丢弃，ready 时按序冲刷。 */
function broadcast(method: string, params: unknown): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const [engine, s] of sessions) {
    if (s.status === "ready") {
      jobs.push(notifyEngine(engine, method, params));
    } else if (s.status === "starting") {
      let q = startingQueues.get(engine);
      if (!q) {
        q = [];
        startingQueues.set(engine, q);
      }
      q.push({ method, params });
      // 队列上限防御：极端情况下（引擎永远不 ready）不无界增长
      if (q.length > 500) q.splice(0, q.length - 500);
    }
  }
  return Promise.all(jobs).then(() => undefined);
}

/** CR-23：引擎就绪时冲刷排队中的文档同步通知（didOpen/didChange 按到达序） */
function flushStartingQueue(engine: string): void {
  const q = startingQueues.get(engine);
  if (!q) return;
  startingQueues.delete(engine);
  for (const { method, params } of q) void notifyEngine(engine, method, params);
}

/** CR-23：引擎确定不会就绪（退出/错误/停止）时丢弃排队，防泄漏 */
function dropStartingQueue(engine: string): void {
  startingQueues.delete(engine);
}

// ---------- 位置换算（LSP UTF-16 0 基 ↔ Monaco 1 基） ----------

function lspPosToMonaco(p: LspPosition): MonacoApi.Position {
  return new monaco.Position(p.line + 1, p.character + 1);
}

function monacoPosToLsp(p: MonacoApi.Position): LspPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

function fileUriToPath(uri: string): string {
  // file:///F:/a/b.py → F:\a\b.py（Windows）；file:///home/u/a.py → /home/u/a.py（Unix）
  let p = uri;
  if (p.startsWith("file:///")) p = p.slice(8);
  else if (p.startsWith("file://")) p = p.slice(7);
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    decoded = p; // tech-debt #6：非法 `%` 序列兜底，不让整条解析崩溃
  }
  // Windows 盘符路径转反斜杠；Unix 路径保留正斜杠
  return /^[A-Za-z]:/.test(decoded) ? decoded.replace(/\//g, "\\") : decoded;
}

function pathToFileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  // tech-debt #6：先手动转义 `encodeURI` 不覆盖的 `%` `#` `?`，再交 encodeURI 处理空格/中文等
  const pre = normalized.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F");
  return "file:///" + encodeURI(pre);
}

/** CR-29：工作区 rootUri 构造（导出供 main.ts / settingsPanel.ts 复用）。
 * 原两处手拼 `file:///${root.replace(/\\/g,"/")}` 不做百分号编码——工作区路径含
 * 空格/中文时与 didOpen.uri（pathToFileUri 已正确编码）前缀不一致，引擎无法关联工作区。 */
export function workspaceRootUri(root: string): string {
  return pathToFileUri(root);
}

// ---------- 生命周期 ----------

interface EngineInfo { name: string; command: string; args: string[] }

// 当前引擎名与解释器（供 workspace/configuration 响应，P25-T06）
let currentEngine = "pyrefly";
let currentInterpreter: string | null = null;

/** CR-21：ensureListeners 的 in-flight Promise 缓存。
 * 原守卫在 `await listen()` 之后才赋值 unlistenMessage，并发调用（startEngine+startIntel）
 * 都过守卫 → 注册两套监听器（前一套 unlisten 泄漏），服务端请求被 lsp_send_response 响应两次。 */
let listenersPromise: Promise<void> | null = null;

/** CR-24：监听器句柄不再 `void x;` 骗编译器丢弃——统一提供销毁入口。
 * 监听器与 WebView 同生命周期，正常运行不销毁；此导出供测试 teardown /
 * 未来多窗口场景使用（语义显式化而非假装使用过）。 */
export function disposeListeners(): void {
  unlistenMessage?.();
  unlistenExit?.();
  unlistenStderr?.();
  unlistenMessage = null;
  unlistenExit = null;
  unlistenStderr = null;
  listenersPromise = null;
}

/** 事件监听（幂等：只挂一次；payload 带 engine 字段，按引擎分发） */
async function ensureListeners(): Promise<void> {
  listenersPromise ??= doEnsureListeners();
  return listenersPromise;
}

async function doEnsureListeners(): Promise<void> {
  if (unlistenMessage) return;

  unlistenMessage = await getCurrentWindow().listen<{ engine?: string; id?: number; method?: string; params?: any; result?: any; error?: any }>(
    "lsp-message",
    (e) => {
      const msg = e.payload;
      const eng = typeof msg.engine === "string" ? msg.engine : "static";
      const s = session(eng);
      if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined || msg.method === undefined)) {
        settlePending(s, msg.id, (p) => {
          if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        });
      } else if (msg.method) {
        const h = notificationHandlers.get(msg.method);
        if (h) h(msg.params, eng);
        // 服务端→客户端请求（如 workspace/configuration）：必须响应，否则引擎挂起等待
        // （P1-BUG-001 根因：basedpyright initialize 后发配置请求，桥不响应 → 补全永不返回）
        if (msg.id !== undefined && msg.id !== null) {
          const result =
            msg.method === "workspace/configuration"
              ? buildConfigResponse(msg.params)
              : null;
          invoke("lsp_send_response", { engine: eng, id: msg.id, result }).catch(console.error);
        }
      }
    },
  );
  unlistenExit = await getCurrentWindow().listen<{ engine?: string; code: number | null }>("lsp-exit", (e) => {
    const eng = e.payload?.engine ?? "static";
    const s = session(eng);
    const err = new Error(t("ide.lsp.processExited", { code: String(e.payload?.code) }));
    for (const [, p] of s.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    s.pending.clear();
    s.status = "exited";
    dropStartingQueue(eng); // CR-23：进程已退，排队通知永不送达
    if (eng === "static") setEngineStatus("exited");
  });
  unlistenStderr = await getCurrentWindow().listen<{ engine?: string; data: string }>("lsp-stderr", (e) => {
    console.warn(`[lsp-stderr:${e.payload?.engine ?? "static"}]`, e.payload?.data);
  });
}

export async function startEngine(engine: string, rootUri: string, interpreter: string | null, cwd?: string): Promise<void> {
  await stopEngine();
  setEngineStatus("starting");
  // 阶段 4 子项 1c：owner 感知清空——只清静态引擎桶（pylume-lsp），
  // pylume-intel / pylume-pydantic 等自研桶不随引擎切换失效
  //（pydantic 诊断不属于任何静态引擎，切引擎丢它是语义错误）。
  clearEngineDiagnostics();
  currentEngine = engine;
  currentInterpreter = interpreter;

  const engines: Record<string, EngineInfo> = {
    pyrefly: { name: "pyrefly", command: "pyrefly", args: ["lsp"] },
    basedpyright: { name: "basedpyright", command: "basedpyright-langserver", args: ["--stdio"] },
  };
  const info = engines[engine] ?? engines.pyrefly;

  await ensureListeners();

  session("static").status = "starting";
  // cwd = 工作区根：pyrefly 从进程 cwd 发现 pyproject.toml 并启动工作区索引；
  // 不传则引擎继承应用目录 → 永远找不到 config → references/rename 只覆盖已 open 文件
  await invoke("lsp_start", { engine: "static", command: info.command, args: info.args, cwd: cwd ?? null });

  // initialize 握手
  const initResult = await request("initialize", {
    processId: null,
    rootUri,
    // pyrefly 通过 initializationOptions.pythonPath 指定解释器（P25-T06 spike 结论）
    // typeCheckingMode=default 让「有内置 stub 但未装源码」的库也报诊断（阶段2 灯泡据此出「安装 X」）
    initializationOptions: {
      ...(interpreter ? { pythonPath: interpreter } : {}),
      pyrefly: { typeCheckingMode: "default" },
    },
    capabilities: {
      textDocumentSync: 2, // incremental
      save: { includeText: true },
      completionProvider: { triggerCharacters: [".", "_"], resolveProvider: true },
      hoverProvider: true,
      definitionProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      codeActionProvider: true,
      renameProvider: true,
      referencesProvider: true,
      // 面包屑/大纲修复：pyrefly 在客户端未声明 hierarchicalDocumentSymbolSupport 时，
      // 会让 textDocument/documentSymbol 返回空（facebook/pyrefly#3555）。
      // 声明后才会返回层次化 DocumentSymbol[]。
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      },
    },
  });
  notify("initialized", {});
  session("static").status = "ready";
  flushStartingQueue("static"); // CR-23：冲刷 starting 期间排队的文档同步
  setEngineStatus("ready");
  // 阶段 4 子项 1c：引擎重启后重放缓存的非引擎诊断（pylume-pydantic 桶等）。
  // 已打开 model 由 main 的 onEngineStatus 监听统一重放（这里只负责状态翻转通知）。
  // PR-N：inlay hints 配置必须在就绪**之后**推（pyrefly 默认 `callArgumentNames: "off"`，
  // 不推就永远只有变量类型提示、没有参数名提示）。推的是 Pyright 兼容设置形态
  // （探针实测：python.analysis.inlayHints.callArgumentNames = "all" 立即生效，引擎侧 150ms 防抖）。
  // 注意不要挪到 status = "ready" 之前——pushInlayHintSettings 自身有「未就绪即短路」守卫。
  void pushInlayHintSettings();
  return initResult;
}

interface IntelInfo { command: string | null; traceDbPath: string }

/** 启动 pylume-intel（运行时引擎）。失败/未构建仅静默降级，静态引擎照常工作。 */
export async function startIntel(workspaceRoot: string, rootUri: string): Promise<boolean> {
  const s = session("intel");
  for (const [, p] of s.pending) {
    clearTimeout(p.timer); // CR-11
    p.reject(new Error("intel 重启"));
  }
  s.pending.clear();
  dropStartingQueue("intel"); // CR-23：旧实例的排队作废

  let info: IntelInfo;
  try {
    info = await invoke<IntelInfo>("get_intel_info", { workspaceRoot });
  } catch (e) {
    console.warn("[intel] 获取启动信息失败:", e);
    s.status = "error";
    return false;
  }
  if (!info.command) {
    console.warn("[intel] 未找到 pylume-intel 二进制，运行时智能不可用（可先构建 intel）");
    s.status = "error";
    return false;
  }

  await ensureListeners();
  s.status = "starting";
  try {
    await invoke("lsp_start", { engine: "intel", command: info.command, args: [], cwd: workspaceRoot });
    await requestEngine("intel", "initialize", {
      processId: null,
      rootUri,
      initializationOptions: { traceDbPath: info.traceDbPath },
      capabilities: {
        textDocumentSync: 2,
        completionProvider: { triggerCharacters: [".", "_"], resolveProvider: true },
        hoverProvider: true,
        definitionProvider: true,
      },
    });
    notifyEngine("intel", "initialized", {});
    s.status = "ready";
    flushStartingQueue("intel"); // CR-23：冲刷 starting 期间排队的文档同步
    return true;
  } catch (e) {
    console.warn("[intel] 启动失败，仅静态引擎工作:", e);
    s.status = "error";
    dropStartingQueue("intel");
    return false;
  }
}

export async function stopEngine(): Promise<void> {
  try {
    await invoke("lsp_stop", { engine: "*" });
  } catch { /* 未启动时忽略 */ }
  const err = new Error(t("ide.lsp.stopped"));
  for (const [, s] of sessions) {
    for (const [, p] of s.pending) {
      clearTimeout(p.timer); // CR-11：清超时句柄
      p.reject(err);
    }
    s.pending.clear();
    s.status = "off";
    dropStartingQueue(s.engine); // CR-23
  }
  sessions.clear();
  setEngineStatus("off");
}

/** 单独停止运行时引擎（pylume-intel），静态引擎不动（P3-T09 一键关闭） */
export async function stopIntel(): Promise<void> {
  try {
    await invoke("lsp_stop", { engine: "intel" });
  } catch { /* 未启动时忽略 */ }
  const s = session("intel");
  const err = new Error(t("ide.lsp.intelClosed"));
  for (const [, p] of s.pending) {
    clearTimeout(p.timer); // CR-11
    p.reject(err);
  }
  s.pending.clear();
  s.status = "off";
  dropStartingQueue("intel"); // CR-23
}

/**
 * workspace/configuration 响应（P25-T06）：
 * - basedpyright：section === "python" 返回 { pythonPath }，其余 null；
 * - 其他引擎（pyrefly 走 initializationOptions.pythonPath）返回全 null 数组。
 */
function buildConfigResponse(params: any): any[] | null {
  const items = params?.items;
  if (!Array.isArray(items)) return null;
  return items.map((it: any) =>
    currentEngine === "basedpyright" && it?.section === "python" && currentInterpreter
      ? { pythonPath: currentInterpreter }
      : null,
  );
}

// ---------- 文档同步 ----------

export function didOpen(path: string, model: MonacoApi.editor.ITextModel): void {
  void broadcast("textDocument/didOpen", {
    textDocument: {
      uri: pathToFileUri(path),
      languageId: "python",
      version: model.getVersionId(),
      text: model.getValue(),
    },
  });
}

/** 未打开文件的内容级 didOpen（重命名跨文件写盘后让引擎索引跟上，引用计数才不会错） */
function didOpenText(path: string, text: string): Promise<void> {
  return broadcast("textDocument/didOpen", {
    textDocument: {
      uri: pathToFileUri(path),
      languageId: "python",
      version: 1,
      text,
    },
  });
}

/**
 * 全量同步：防抖窗口结束时发送当前全文。
 * 注意：不用 range-based 增量——pyrefly 的 contentChanges 语义是「替换文档状态」，
 * 多次独立增量会与服务端状态错位（实测补全丢失）。
 * 全量对小文件开销可忽略，正确性优先。
 */
export function didChangeFull(path: string, model: MonacoApi.editor.ITextModel): Promise<void> {
  return broadcast("textDocument/didChange", {
    textDocument: { uri: pathToFileUri(path), version: model.getVersionId() },
    contentChanges: [{ text: model.getValue() }],
  });
}

/**
 * 增量同步：只发「自上次同步起」的编辑序列（Monaco IModelContentChange[] → LSP contentChanges）。
 * basedpyright（Pyright 内核）对 LSP 增量可靠；pyrefly 对多 range 增量有实测错位
 * （补全丢失，见 didChangeFull 注释），故非 basedpyright 时回落全量。
 * Monaco 的 e.changes 按时间顺序累积时，其 range 坐标语义与 LSP 增量一致
 * （每个 range 基于前一个 change 应用后的文档），直接映射即可，无需重算。
 */
export function didChange(
  path: string,
  model: MonacoApi.editor.ITextModel,
  changes: MonacoApi.editor.IModelContentChange[],
): Promise<void> {
  if (currentEngine !== "basedpyright") {
    return didChangeFull(path, model);
  }
  const contentChanges = changes.map((c) => ({
    range: {
      start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
      end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
    },
    text: c.text,
  }));
  return broadcast("textDocument/didChange", {
    textDocument: { uri: pathToFileUri(path), version: model.getVersionId() },
    contentChanges,
  });
}

export function didClose(path: string): void {
  void broadcast("textDocument/didClose", { textDocument: { uri: pathToFileUri(path) } });
}

/** 保存通知（引擎常在保存时触发完整重新检查） */
export function didSave(path: string, model: MonacoApi.editor.ITextModel): void {
  void broadcast("textDocument/didSave", {
    textDocument: { uri: pathToFileUri(path) },
    text: model.getValue(),
  });
}

/** 文档符号（P25-T07 大纲）：textDocument/documentSymbol */
export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range?: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export async function documentSymbols(path: string): Promise<LspDocumentSymbol[]> {
  if (engineStatus !== "ready") return [];
  await flushBeforeSemantic();
  try {
    const result = await request("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileUri(path) },
    });
    // LSP 允许 documentSymbol 返回 null（无符号）；非数组一律按空处理
    return Array.isArray(result) ? (result as LspDocumentSymbol[]) : [];
  } catch {
    return [];
  }
}

// ---------- Monaco providers ----------

/** LSP CompletionItemKind → Monaco kind（惰性构建：注册 provider 时 monaco 已注入） */
let KIND_MAP: Record<number, MonacoApi.languages.CompletionItemKind> = {};
function buildKindMap(): void {
  const K = monaco.languages.CompletionItemKind;
  KIND_MAP = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
    6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
    12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 21: K.Constant, 22: K.Struct,
  };
}

/** InsertAsSnippet 规则值（惰性取：注册时 monaco 已注入） */
let INSERT_AS_SNIPPET = 4;

/**
 * 补全前钩子（P1-BUG-002）：补全请求发出前冲刷防抖窗口内未同步的 didChange。
 * 由 main.ts 注入（需要访问 tabs/pendingChanges，client 不持有编辑器层状态）。
 */
let beforeCompletionHook: ((model: MonacoApi.editor.ITextModel) => Promise<void>) | null = null;
export function setBeforeCompletionHook(fn: (model: MonacoApi.editor.ITextModel) => Promise<void>): void {
  beforeCompletionHook = fn;
}

/**
 * 语义请求前钩子：references / rename / prepareRename / documentSymbol 与补全同理，
 * 发请求前必须冲刷防抖窗口内未同步的 didChange——引擎按旧缓冲计算就会漏改 / 错位
 *（rename 的 edits 范围套到新文本上）。由 main.ts 注入 syncPendingChanges（空集零开销）。
 */
let beforeSemanticHook: (() => Promise<void>) | null = null;
export function setBeforeSemanticHook(fn: () => Promise<void>): void {
  beforeSemanticHook = fn;
}
async function flushBeforeSemantic(): Promise<void> {
  if (beforeSemanticHook) await beforeSemanticHook();
}

/** 查询某引擎的补全项（引擎未就绪返回空数组） */
async function queryCompletion(engine: string, params: unknown): Promise<LspCompletionItem[]> {
  const s = session(engine);
  if (s.status !== "ready") return [];
  const result = await requestEngine(engine, "textDocument/completion", params);
  return Array.isArray(result) ? result : (result?.items ?? []);
}

/** LSP 补全项 → Monaco 补全项（附引擎标识 __engine，供 resolve 回源） */
function toMonacoItem(
  it: LspCompletionItem,
  sortText: string,
  range: { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number },
  engine: string,
) {
  return {
    label: it.label,
    kind: KIND_MAP[it.kind ?? 0] ?? monaco.languages.CompletionItemKind.Text,
    detail: it.detail ?? it.labelDetails?.detail,
    documentation:
      typeof it.documentation === "string" ? it.documentation : it.documentation?.value,
    insertText: it.insertText ?? it.label,
    insertTextRules: it.insertTextFormat === 2 ? INSERT_AS_SNIPPET : undefined,
    sortText,
    filterText: it.filterText,
    range,
    __lspItem: it,
    __engine: engine,
  } as MonacoApi.languages.CompletionItem;
}

/** 补全三层合并：intel `1xx`（运行时）/ 静态 `2xx`（模板 0xx 在 main.ts 的 smart template provider） */
export function registerLspCompletion(): MonacoApi.IDisposable {
  INSERT_AS_SNIPPET =
    ((monaco.languages as any).CompletionItemInsertTextRule?.InsertAsSnippet) ?? 4;
  return monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", "_", "\"", "'", "["],
    async provideCompletionItems(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position) {
      if (engineStatus !== "ready") return { suggestions: [] };
      // 先冲刷未同步的文档变更，再发补全请求（顺序保证：await 同步帧写入后才发请求）
      if (beforeCompletionHook) await beforeCompletionHook(model);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const params = {
        textDocument: { uri: pathToFileUri(currentPath(model)) },
        position: monacoPosToLsp(position),
      };

      const [staticItems, intelItems] = await Promise.all([
        queryCompletion("static", params).catch(() => [] as LspCompletionItem[]),
        queryCompletion("intel", params).catch(() => [] as LspCompletionItem[]),
      ]);

      const suggestions: MonacoApi.languages.CompletionItem[] = [];
      let si = 0;
      for (const it of staticItems) {
        suggestions.push(toMonacoItem(it, "2" + String(si++).padStart(3, "0"), range, "static"));
      }
      for (const it of intelItems) {
        // intel 自带 sortText（"1xx"，hits/obs 降序）；缺失则兜底放到段尾
        suggestions.push(toMonacoItem(it, it.sortText ?? "1" + String(998), range, "intel"));
      }
      return { suggestions };
    },
    /**
     * 二段补全（P1-BUG-001 修复）：Monaco 选中候选项时调用 completionItem/resolve，
     * 获取 detail/documentation/insertText/additionalTextEdits 等完整信息。
     * basedpyright 的初始补全列表常缺 detail 与 insertText，必须 resolve 才完整。
     */
    async resolveCompletionItem(item: MonacoApi.languages.CompletionItem) {
      const lspItem = (item as any).__lspItem as LspCompletionItem | undefined;
      if (!lspItem) return item;
      const engine = (item as any).__engine ?? "static";
      try {
        const resolved: LspCompletionItem = await requestEngine(engine, "completionItem/resolve", lspItem);
        if (resolved.detail) item.detail = resolved.detail;
        if (resolved.documentation) {
          item.documentation =
            typeof resolved.documentation === "string"
              ? { value: resolved.documentation }
              : resolved.documentation;
        }
        if (resolved.insertText) {
          item.insertText = resolved.insertText;
          item.insertTextRules = resolved.insertTextFormat === 2 ? INSERT_AS_SNIPPET : undefined;
        }
        if (resolved.additionalTextEdits?.length) {
          item.additionalTextEdits = resolved.additionalTextEdits.map((e) => {
            const s = lspPosToMonaco(e.range.start);
            const en = lspPosToMonaco(e.range.end);
            return {
              range: new monaco.Range(s.lineNumber, s.column, en.lineNumber, en.column),
              text: e.newText,
            };
          });
        }
      } catch { /* resolve 失败保持原样 */ }
      return item;
    },
  });
}

function currentPath(model: MonacoApi.editor.ITextModel): string {
  return (model as any).__pylumePath ?? "";
}

export function markModelPath(model: MonacoApi.editor.ITextModel, path: string): void {
  (model as any).__pylumePath = path;
}

/** model → 文件路径（由 markModelPath 设置）；未标记返回 null（live templates M2 符号索引用） */
export function modelPath(model: MonacoApi.editor.ITextModel): string | null {
  return (model as any).__pylumePath ?? null;
}

/** Hover contents 归一化为纯文本（空则 ""） */
function hoverToText(h: LspHover | null): string {
  if (!h) return "";
  const contents = h.contents as any;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.join("\n\n");
  if (contents?.value) return contents.value;
  return "";
}

/** 查询某引擎 hover（未就绪/失败返回 null） */
async function queryHover(engine: string, params: unknown): Promise<LspHover | null> {
  const s = session(engine);
  if (s.status !== "ready") return null;
  try {
    return (await requestEngine(engine, "textDocument/hover", params)) as LspHover | null;
  } catch {
    return null;
  }
}

/** Hover 合并：静态 + 运行时（intel）拼接展示；调试暂停时并入运行时求值（B-8）。
 *  库特别支持 PR-2（R-1 结论）：正则字面量 hover 作为自研段**追加进本合并管线**——
 *  不注册第二 hover provider（Monaco 多 provider 合并行为未验证），与 intel 合并同源。 */
export function registerLspHover(): MonacoApi.IDisposable {
  return monaco.languages.registerHoverProvider("python", {
    async provideHover(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position) {
      // 自研段：正则 / 格式串字面量解释（独立于引擎就绪态；libs_regex / libs_format 关闭时返回 null）
      const libsValue = libsHoverAt(model, position);
      if (engineStatus !== "ready") {
        return libsValue ? { range: undefined, contents: [{ value: libsValue }] } : null;
      }
      const params = {
        textDocument: { uri: pathToFileUri(currentPath(model)) },
        position: monacoPosToLsp(position),
      };
      const [staticHover, intelHover] = await Promise.all([
        queryHover("static", params),
        queryHover("intel", params),
      ]);
      const sv = hoverToText(staticHover);
      const iv = hoverToText(intelHover);
      let value = [sv, iv].filter(Boolean).join(sv && iv ? "\n\n" : "");
      if (libsValue) value = value ? `${libsValue}\n\n${value}` : libsValue;
      // B-8：调试暂停时，光标处标识符的**运行时值**并入 hover（context="hover"，
      // DAP 语义为无副作用求值；帧取 debugView 同步过来的镜像）。求值失败静默——
      // hover 是高频路径，失败不该打扰用户。
      if (dap.currentPhase() === "stopped") {
        const word = model.getWordAtPosition(position);
        if (word?.word) {
          try {
            const r = await dap.dapEvaluate(word.word, dap.getActiveFrameId(), "hover");
            if (r.result) {
              const shown = r.result.length > 300 ? `${r.result.slice(0, 299)}…` : r.result;
              const line = `**${t("ide.debugValue")}** \`${shown}\``;
              value = value ? `${value}\n\n${line}` : line;
            }
          } catch {
            /* 无法求值（不在帧上下文/表达式不可见）→ 不显示调试段 */
          }
        }
      }
      if (!value) return null;
      return { range: undefined, contents: [{ value }] };
    },
  });
}

/** 跳转定义回调：由 main.ts 注入（跨文件打开需要编辑器层配合） */
let gotoDefinitionHandler: ((path: string, line: number, col: number) => void) | null = null;
export function setGotoDefinitionHandler(fn: (path: string, line: number, col: number) => void): void {
  gotoDefinitionHandler = fn;
}

/** 查询某引擎定义位置（未就绪/失败返回 null） */
async function queryDefinition(engine: string, params: unknown): Promise<LspLocation[] | LspLocation | null> {
  const s = session(engine);
  if (s.status !== "ready") return null;
  try {
    return (await requestEngine(engine, "textDocument/definition", params)) as LspLocation[] | LspLocation | null;
  } catch {
    return null;
  }
}

/** 查询光标处符号的定义位置（不执行跳转） */
async function fetchDefinitionAt(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
): Promise<{ path: string; line: number; col: number } | null> {
  if (engineStatus !== "ready") return null;
  const params = {
    textDocument: { uri: pathToFileUri(currentPath(model)) },
    position: monacoPosToLsp(position),
  };
  // 静态优先；无结果时 intel 兜底（运行时跳转）
  let locs = await queryDefinition("static", params);
  if (!locs || (Array.isArray(locs) && locs.length === 0)) {
    locs = await queryDefinition("intel", params);
  }
  if (!locs) return null;
  const arr = Array.isArray(locs) ? locs : [locs];
  if (arr.length === 0) return null;
  const target = arr[0];
  const path = fileUriToPath(target.uri);
  const pos = lspPosToMonaco(target.range.start);
  return { path, line: pos.lineNumber, col: pos.column };
}

/**
 * 注册跳转定义：
 * - provider 只返回位置数据（供 Ctrl+悬停下划线/peek 使用），**不执行跳转**；
 * - 真正跳转由显式触发：F12 / Ctrl+点击（见 wireGotoTriggers）。
 */
export function registerLspDefinition(): MonacoApi.IDisposable {
  return monaco.languages.registerDefinitionProvider("python", {
    async provideDefinition(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position) {
      const target = await fetchDefinitionAt(model, position);
      if (!target) return null;
      return [
        {
          uri: monaco.Uri.file(target.path),
          range: {
            startLineNumber: target.line,
            startColumn: target.col,
            endLineNumber: target.line,
            endColumn: target.col + 1,
          },
        },
      ];
    },
  });
}

/** 光标处跳转定义（F12 / Ctrl+点击 / 自定义键 Ctrl+B 的公共入口，见 keybindings.ts） */
export async function gotoDefinitionAtCursor(editor: MonacoApi.editor.IStandaloneCodeEditor): Promise<void> {
  const pos = editor.getPosition();
  const model = editor.getModel();
  if (!pos || !model) return;
  const target = await fetchDefinitionAt(model, pos);
  if (target && gotoDefinitionHandler) gotoDefinitionHandler(target.path, target.line, target.col);
}

/** 显式跳转触发器：F12 与 Ctrl+鼠标点击（Ctrl+悬停不跳转） */
export function wireGotoTriggers(editor: MonacoApi.editor.IStandaloneCodeEditor): void {
  // F12
  editor.addCommand(monaco.KeyCode.F12, () => void gotoDefinitionAtCursor(editor));

  // Ctrl+点击（仅按下 Ctrl 且是左键时触发）
  editor.onMouseDown((e) => {
    if (
      e.event.ctrlKey &&
      !e.event.altKey &&
      !e.event.shiftKey &&
      !e.event.metaKey &&
      e.event.leftButton &&
      e.target?.position
    ) {
      editor.setPosition(e.target.position);
      void gotoDefinitionAtCursor(editor);
    }
  });
}

// ---------- 符号重命名（textDocument/rename） ----------

interface LspTextEdit {
  range: LspRange;
  newText?: string;
}

interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number };
  edits?: LspTextEdit[];
}

interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  /** LSP 3.17 形态（pyrefly 等引擎可能返回这种而非 changes）：漏解析会整块漏改 */
  documentChanges?: LspTextDocumentEdit[];
}

/** LSP TextEdit[] → 字符串层应用（对未打开文件；UTF-16 offset 计算，CRLF/LF 均正确） */
function applyEditsToString(content: string, edits: LspTextEdit[]): string {
  const lines = content.split("\n");
  const lineStarts: number[] = [];
  let pos = 0;
  for (const ln of lines) {
    lineStarts.push(pos);
    pos += ln.length + 1; // +1 为分隔符 '\n'；CRLF 的 '\r' 已计入 ln.length
  }
  const offsetOf = (line: number, character: number): number => lineStarts[line] + character;
  const ops = edits.map((e) => ({
    start: offsetOf(e.range.start.line, e.range.start.character),
    end: offsetOf(e.range.end.line, e.range.end.character),
    text: e.newText ?? "",
  }));
  ops.sort((a, b) => b.start - a.start); // 倒序应用，避免后续 offset 偏移
  let result = content;
  for (const op of ops) {
    result = result.slice(0, op.start) + op.text + result.slice(op.end);
  }
  return result;
}

/** LSP TextEdit[] → 已打开 model（倒序 pushEditOperations，触发 didChange 同步） */
function applyEditsToModel(model: MonacoApi.editor.ITextModel, edits: LspTextEdit[]): void {
  const ops = edits.map((e) => {
    const start = lspPosToMonaco(e.range.start);
    const end = lspPosToMonaco(e.range.end);
    return {
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      text: e.newText ?? "",
    };
  });
  ops.sort((a, b) => (b.range.startLineNumber - a.range.startLineNumber) || (b.range.startColumn - a.range.startColumn));
  model.pushEditOperations([], ops as MonacoApi.editor.IIdentifiedSingleEditOperation[], () => null);
}

/**
 * 应用跨文件 WorkspaceEdit（除 localPath 归一路径外）：已打开文件走 model 编辑 + 写盘 +
 * didSave；未打开文件走读盘 → 字符串应用 → 写盘。返回应用到的 edit 总数。
 */
async function applyWorkspaceChanges(
  changes: Record<string, LspTextEdit[]>,
  localPath: string,
): Promise<number> {
  let applied = 0;
  for (const [uri, edits] of Object.entries(changes)) {
    const path = fileUriToPath(uri);
    if (normPath(path) === localPath) continue;
    const openModel = app.tabs.find((t) => normPath(t.path) === normPath(path))?.model;
    if (openModel) {
      applyEditsToModel(openModel, edits);
      await invoke("write_file", { path, content: openModel.getValue() });
      didSave(path, openModel);
      // 立即同步引擎（不等 200ms 防抖）：否则窗口内 references 计数按旧内容算
      await didChangeFull(path, openModel);
    } else {
      const content = await invoke<string>("read_file", { path });
      const newContent = applyEditsToString(content, edits);
      await invoke("write_file", { path, content: newContent });
      // 引擎从没见过这个文件的这次改动（didOpen 只在打开 tab 时发）——不发引擎索引
      // 停在旧内容，重命名后的引用计数 / 引用列表会持续错误
      await didOpenText(path, newContent);
    }
    applied += edits.length;
  }
  return applied;
}

export interface RenameResult {
  /** 涉及改动的文件数 */
  changedFiles: number;
  /** 改动的定义 / 引用总数 */
  totalEdits: number;
}

/** 单条重命名编辑（Monaco 1-based 坐标，供 UI 预览与统一应用） */
export interface RenameEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/** 单文件的重命名编辑集 */
export interface RenameFileEdits {
  path: string;
  edits: RenameEdit[];
}

/**
 * prepareRename：确认光标处可重命名并锚定符号范围（就地改名的第一步，
 * 光标落在注释 / 字符串上时返回 null，避免盲改）。
 */
export async function fetchRenameAnchor(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
): Promise<{ range: MonacoApi.Range; placeholder: string } | null> {
  if (engineStatus !== "ready") return null;
  await flushBeforeSemantic();
  try {
    const r = await request("textDocument/prepareRename", {
      textDocument: { uri: pathToFileUri(currentPath(model)) },
      position: monacoPosToLsp(position),
    });
    if (!r) return null;
    // LSP 返回两种形态：{ range, placeholder }（3.16+）或 [range, placeholder]（3.14-3.15）
    let range: LspRange | null = null;
    let placeholder = "";
    if (Array.isArray(r)) {
      range = (r[0] as LspRange) ?? null;
      placeholder = typeof r[1] === "string" ? r[1] : "";
    } else {
      const obj = r as { range?: LspRange; placeholder?: string };
      range = obj.range ?? null;
      placeholder = obj.placeholder ?? "";
    }
    if (!range) return null;
    const start = lspPosToMonaco(range.start);
    const end = lspPosToMonaco(range.end);
    return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), placeholder };
  } catch {
    return null;
  }
}

/**
 * 请求跨文件重命名编辑集（textDocument/rename）：只计算不落盘。
 * 返回按文件分组的 Monaco 坐标编辑集，交互层（renameWidget.ts）先做 diff 预览再应用。
 */
export async function fetchRenameChanges(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
  newName: string,
): Promise<RenameFileEdits[]> {
  if (engineStatus !== "ready") throw new Error(t("ide.lsp.notReady"));
  await flushBeforeSemantic();
  const result = await request("textDocument/rename", {
    textDocument: { uri: pathToFileUri(currentPath(model)) },
    position: monacoPosToLsp(position),
    newName,
  });
  const we = result as LspWorkspaceEdit;
  const byPath = new Map<string, RenameEdit[]>();
  const collect = (uri: string, edits: LspTextEdit[] | undefined): void => {
    const path = fileUriToPath(uri);
    const arr = byPath.get(path) ?? [];
    for (const it of edits ?? []) {
      const start = lspPosToMonaco(it.range.start);
      const end = lspPosToMonaco(it.range.end);
      arr.push({
        startLine: start.lineNumber,
        startColumn: start.column,
        endLine: end.lineNumber,
        endColumn: end.column,
        text: it.newText ?? "",
      });
    }
    byPath.set(path, arr);
  };
  for (const [uri, edits] of Object.entries(we?.changes ?? {})) collect(uri, edits);
  for (const de of we?.documentChanges ?? []) collect(de.textDocument.uri, de.edits);
  return [...byPath.entries()].map(([path, edits]) => ({ path, edits }));
}

/** RenameEdit[] → 内部 LSP 坐标（复用既有 model / 字符串应用实现） */
function toLspEdits(edits: RenameEdit[]): LspTextEdit[] {
  return edits.map((e) => ({
    range: {
      start: { line: e.startLine - 1, character: e.startColumn - 1 },
      end: { line: e.endLine - 1, character: e.endColumn - 1 },
    },
    newText: e.text,
  }));
}

/** 重命名编辑集应用到字符串（未打开文件的 diff 预览用；Monaco 1-based 坐标） */
export function applyRenameEditsToText(content: string, edits: RenameEdit[]): string {
  const lines = content.split("\n");
  const lineStarts: number[] = [];
  let pos = 0;
  for (const ln of lines) {
    lineStarts.push(pos);
    pos += ln.length + 1;
  }
  const offsetOf = (line: number, col: number): number => lineStarts[line - 1] + (col - 1);
  const ops = edits.map((e) => ({
    start: offsetOf(e.startLine, e.startColumn),
    end: offsetOf(e.endLine, e.endColumn),
    text: e.text,
  }));
  ops.sort((a, b) => b.start - a.start); // 倒序应用，避免后续 offset 偏移
  let result = content;
  for (const op of ops) {
    result = result.slice(0, op.start) + op.text + result.slice(op.end);
  }
  return result;
}

/**
 * 应用重命名编辑集：当前文件走单批 pushEditOperations（一个 undo 原子）+ 写盘 + didSave；
 * 其余文件经 applyWorkspaceChanges（已打开 → model 编辑，未打开 → 字符串层应用）。
 */
export async function applyRenameChanges(
  model: MonacoApi.editor.ITextModel,
  files: RenameFileEdits[],
): Promise<void> {
  const localNorm = normPath(currentPath(model));
  const local = files.find((f) => normPath(f.path) === localNorm);
  if (local && local.edits.length > 0) {
    applyEditsToModel(model, toLspEdits(local.edits));
    await invoke("write_file", { path: currentPath(model), content: model.getValue() });
    didSave(currentPath(model), model);
    // 立即同步引擎（不等 200ms 防抖），窗口内的引用计数请求才不会按旧内容算
    await didChangeFull(currentPath(model), model);
  }
  const changes: Record<string, LspTextEdit[]> = {};
  for (const f of files) {
    if (normPath(f.path) === localNorm) continue;
    changes[pathToFileUri(f.path)] = toLspEdits(f.edits);
  }
  await applyWorkspaceChanges(changes, localNorm);
}

/**
 * 跨文件重命名（引用面板「重命名」等旧入口）：请求 + 应用一步完成，返回改动规模供 UI 提示。
 * 就地改名交互（ghost 预览 / diff 预览）见 renameWidget.ts。
 */
export async function renameSymbol(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
  newName: string,
): Promise<RenameResult> {
  const files = await fetchRenameChanges(model, position, newName);
  await applyRenameChanges(model, files);
  return {
    changedFiles: files.length,
    totalEdits: files.reduce((n, f) => n + f.edits.length, 0),
  };
}

// ---------- 查找引用（textDocument/references） ----------

export interface LspReferenceLocation {
  path: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

function sameRefs(a: LspReferenceLocation[], b: LspReferenceLocation[]): boolean {
  if (a.length !== b.length) return false;
  const key = (r: LspReferenceLocation): string => `${r.path}:${r.line}:${r.col}:${r.endLine}:${r.endCol}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}

/**
 * 等待引擎对该符号的引用索引稳定（pyrefly lsp 默认 lazy-non-blocking-background 索引：
 * 打开首个文件后才在后台建索引，未完成时 references / rename 只覆盖已索引文件 →
 * 重命名漏改 / 引用计数偏小）。连续两次结果全等即认为稳定；已稳定时只多一次请求。
 * onSample：每次采样回调（renameWidget 借此实时刷新 ghost 计数）。
 * onSettled：结束回调（E-2），stable=false 表示轮询次数用尽仍未收敛——调用方应提示
 * 「工作区索引可能尚未完成，结果可能不完整」（G-3：禁止静默不完整）。
 */
export async function waitReferencesStable(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
  opts: { maxTries?: number; intervalMs?: number; onSample?: (refs: LspReferenceLocation[]) => void; onSettled?: (stable: boolean) => void } = {},
): Promise<LspReferenceLocation[]> {
  const maxTries = opts.maxTries ?? 6;
  const intervalMs = opts.intervalMs ?? 700;
  let prev: LspReferenceLocation[] | null = null;
  for (let i = 0; i < maxTries; i++) {
    const cur = await fetchReferencesAt(model, position);
    opts.onSample?.(cur);
    if (prev && sameRefs(prev, cur)) {
      opts.onSettled?.(true);
      return cur;
    }
    prev = cur;
    if (i < maxTries - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  opts.onSettled?.(false);
  return prev ?? [];
}

/** 查询光标处符号的所有引用（供 Shift+F12 与全局搜索面板复用） */
export async function fetchReferencesAt(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
): Promise<LspReferenceLocation[]> {
  if (engineStatus !== "ready") return [];
  await flushBeforeSemantic();
  try {
    const locs: LspLocation[] | null = await request("textDocument/references", {
      textDocument: { uri: pathToFileUri(currentPath(model)) },
      position: monacoPosToLsp(position),
      context: { includeDeclaration: true },
    });
    if (!locs) return [];
    return locs.map((loc) => {
      const start = lspPosToMonaco(loc.range.start);
      const end = lspPosToMonaco(loc.range.end);
      return { path: fileUriToPath(loc.uri), line: start.lineNumber, col: start.column, endLine: end.lineNumber, endCol: end.column };
    });
  } catch {
    return [];
  }
}

/** 注册引用查找 provider（Shift+F12）：结果以 peek 视图展示 */
export function registerLspReferences(): MonacoApi.IDisposable {
  return monaco.languages.registerReferenceProvider("python", {
    async provideReferences(model, position, context) {
      void context;
      const refs = await fetchReferencesAt(model, position);
      return refs.map((r) => ({
        uri: monaco.Uri.file(r.path),
        range: {
          startLineNumber: r.line,
          startColumn: r.col,
          endLineNumber: r.endLine,
          endColumn: r.endCol,
        },
      }));
    },
  });
}

// ---------- 签名帮助（textDocument/signatureHelp） ----------

interface LspParameterInfo {
  label: string | [number, number];
  documentation?: string | { value: string };
}
interface LspSignatureInfo {
  label: string;
  documentation?: string | { value: string };
  parameters?: LspParameterInfo[];
}
interface LspSignatureHelp {
  signatures: LspSignatureInfo[];
  activeSignature?: number;
  activeParameter?: number;
}

/** 注册签名帮助 provider：输入 ( 或 , 时触发参数提示 */
export function registerLspSignatureHelp(): MonacoApi.IDisposable {
  return monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position) {
      if (engineStatus !== "ready") return null;
      if (beforeCompletionHook) await beforeCompletionHook(model);
      try {
        const result: LspSignatureHelp | null = await request("textDocument/signatureHelp", {
          textDocument: { uri: pathToFileUri(currentPath(model)) },
          position: monacoPosToLsp(position),
        });
        if (!result || !result.signatures?.length) return null;
        return {
          value: {
            signatures: result.signatures.map((sig) => ({
              label: sig.label,
              documentation:
                typeof sig.documentation === "string"
                  ? sig.documentation
                  : sig.documentation?.value,
              parameters: (sig.parameters ?? []).map((p) => ({
                label: p.label,
                documentation:
                  typeof p.documentation === "string"
                    ? p.documentation
                    : p.documentation?.value,
              })),
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose: () => {},
        };
      } catch {
        return null;
      }
    },
  });
}

// ---------- 缺失包安装提示（借鉴 PyCharm） ----------

/** 安装包动作的命令 id：由 main.ts 经 editor.addAction 注册为可执行命令 */
export const INSTALL_PACKAGE_COMMAND = "pylume.installPackage";

/** 判定诊断 code 是否为「缺失 import / 缺源码」类（pyrefly: missing-import；basedpyright: reportMissingImports / reportMissingModuleSource） */
function isMissingImportCode(code: string): boolean {
  const c = code.toLowerCase();
  return (
    c.includes("missing-import") ||
    c.includes("missing-source") || // pyrefly: missing-source-for-stubs（内置 stub 但解释器缺源码，即 typeCheckingMode=default 的目标场景）
    c.includes("reportmissingimports") ||
    c.includes("reportmissingmodulesource")
  );
}

/** 从诊断 message 提取引号 / 反引号包裹的模块名，并取顶层包名（`a.b.c` → `a`） */
function extractTopModule(msg: string): string | null {
  const m = msg.match(/[`'"]([A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)[`'"]/);
  if (!m) return null;
  return m[1].split(".")[0];
}

/** 若 marker 是「缺失第三方 import」诊断，返回应安装的顶层包名；否则 null */
function missingModuleFromMarker(m: MonacoApi.editor.IMarkerData): string | null {
  const codeStr = typeof m.code === "string"
    ? m.code
    : m.code ? String((m.code as { value?: unknown }).value ?? "") : "";
  const msg = m.message ?? "";
  const byCode = isMissingImportCode(codeStr);
  // 消息兜底：引擎偶发不带 code 时，靠经典措辞识别
  const byMsg = /could not be resolved|no module named|could not find import|unknown import/i.test(msg);
  if (!byCode && !byMsg) return null;
  const top = extractTopModule(msg);
  if (!top) return null;
  if (STDLIB_MODULES.has(top)) return null;
  return top;
}

/** 从一批 markers 提取缺失包，生成「安装 X」CodeAction（去重）。
 *  M3 定位（§6.3）：marker 兜底路径——包名解析已不再依赖硬编码别名（handler 侧
 *  installMissingPackage 用 diff 的 dist 归一结果）；diff 光标行动作命中同一模块时由
 *  provideCodeActions 去重，本路径只在引擎诊断先于 diff 快照到达时兜底。 */
function buildInstallActions(markers: MonacoApi.editor.IMarkerData[]): MonacoApi.languages.CodeAction[] {
  const byPkg = new Map<string, MonacoApi.editor.IMarkerData>();
  for (const m of markers) {
    const pkg = missingModuleFromMarker(m);
    if (pkg && !byPkg.has(pkg)) byPkg.set(pkg, m);
  }
  return [...byPkg.entries()].map(([pkg, marker]) => ({
    title: t("ide.installPkg", { pkg }),
    kind: "quickfix",
    isPreferred: true,
    diagnostics: [marker], // 关联具体诊断，灯泡 hover 与菜单分组更准确
    command: { id: INSTALL_PACKAGE_COMMAND, title: t("ide.installPkgShort", { pkg }), arguments: [pkg] },
  }));
}

/** 「安装 X 并加入 pyproject」动作的命令 id（§6.3 E4/E3 → declare = uv add；main.ts 注册） */
export const DECLARE_PACKAGE_COMMAND = "pylume.declarePackage";

/** 依赖健康灯泡动作（§6.3 M3：diff 数据源 + 光标行匹配定案）：
 *  E1 →「安装 X」（marker 路径保留为兜底）；E4 →「安装 X 并加入 pyproject」。
 *  E4/E3 的 import 可正常解析、无红色 marker——依赖 Monaco 光标移动时自动询问 provider 亮灯泡；
 *  E3 漂移包被本文件 import 时与 E4 是同一事实，收敛为同一 declare 动作（§11 v1.5 口径）。 */
function buildDepLineActions(
  model: MonacoApi.editor.ITextModel,
  range: MonacoApi.Range,
): MonacoApi.languages.CodeAction[] {
  const diff = latestDiff();
  if (!diff) return [];
  const rel = toWorkspaceRelative(currentPath(model), app.workspaceRoot);
  if (!rel) return [];
  const lineText = model.getLineContent(range.startLineNumber);
  const out: MonacoApi.languages.CodeAction[] = [];
  for (const a of depActionsForLine(diff, rel, lineText)) {
    out.push({
      title: a.title,
      kind: "quickfix",
      command: {
        id: a.kind === "install" ? INSTALL_PACKAGE_COMMAND : DECLARE_PACKAGE_COMMAND,
        title: a.title,
        // install 传模块名（handler 从 diff 解析 dist）；declare 传归一后的 spec
        arguments: [a.kind === "install" ? a.module : a.spec],
      },
    });
  }
  return out;
}

// ---------- Code Action 快速修复（textDocument/codeAction） ----------

interface LspCodeAction {
  title: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  isPreferred?: boolean;
  edit?: {
    changes?: Record<string, Array<{ range: LspRange; newText: string }>>;
    documentChanges?: Array<{ textDocument?: { uri: string }; edits?: Array<{ range: LspRange; newText: string }> }>;
  };
  command?: { title: string; command: string; arguments?: unknown[] };
}

/** Monaco MarkerSeverity → LSP DiagnosticSeverity */
function markerSeverityToLsp(sev: number): number {
  switch (sev) {
    case 8: return 1; // Error
    case 4: return 2; // Warning
    case 2: return 3; // Info
    default: return 4; // Hint
  }
}

/**
 * WorkspaceEdit 的 URI 归一比较（CR-22 同族教训）：引擎回包的盘符大小写/编码形态
 * 未必与 model.uri.toString() 逐字相等（pyrefly 实测回 `file:///D:/...`），严格 ===
 * 会把 edit 整块静默丢弃。decode + 分隔符归一 + 小写后再比。
 */
function normUri(u: string): string {
  let s = u;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 非法 % 序列保留原文（tech-debt #6 同口径） */
  }
  return s.replace(/\\/g, "/").toLowerCase();
}

/** 将 LSP WorkspaceEdit（changes 或 documentChanges）转为 Monaco edits（仅当前 model） */
function codeActionEditToMonaco(
  edit: LspCodeAction["edit"],
  model: MonacoApi.editor.ITextModel,
): MonacoApi.languages.IWorkspaceTextEdit[] {
  if (!edit) return [];
  const modelUri = normUri(model.uri.toString());
  const out: MonacoApi.languages.IWorkspaceTextEdit[] = [];
  const pushEdits = (uri: string, items: Array<{ range: LspRange; newText: string }>) => {
    if (normUri(uri) !== modelUri) return;
    for (const it of items) {
      const s = lspPosToMonaco(it.range.start);
      const e = lspPosToMonaco(it.range.end);
      out.push({
        resource: model.uri,
        versionId: undefined,
        textEdit: {
          range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column),
          text: it.newText,
        },
      });
    }
  };
  if (edit.changes) {
    for (const [uri, items] of Object.entries(edit.changes)) pushEdits(uri, items);
  } else if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if (dc.textDocument?.uri && dc.edits) pushEdits(dc.textDocument.uri, dc.edits);
    }
  }
  return out;
}

/** 注册 Code Action provider（Ctrl+. / 灯泡）：LSP codeAction → Monaco 快速修复 */
export function registerLspCodeAction(): MonacoApi.IDisposable {
  return monaco.languages.registerCodeActionProvider("python", {
    async provideCodeActions(model, range, context) {
      const actions: MonacoApi.languages.CodeAction[] = [];
      // 依赖健康动作（§6.3 diff 数据源）：不依赖引擎状态——引擎未 ready 时灯泡仍可装包
      const depActions = buildDepLineActions(model, range);
      actions.push(...depActions);
      if (engineStatus !== "ready") return { actions, dispose: () => {} };
      if (beforeCompletionHook) await beforeCompletionHook(model);

      // 缺失包安装提示（marker 兜底路径）：与 diff 光标行动作同模块时去重（dep 动作优先——
      // 其 spec 已经 dist 归一），仅补 diff 快照尚未覆盖的诊断（引擎先于体检到达的窗口期）
      const depModules = new Set(depActions.map((a) => a.command?.arguments?.[0]));
      actions.push(...buildInstallActions(context.markers).filter((a) => !depModules.has(a.command?.arguments?.[0])));

      const diagnostics = context.markers.map((m) => ({
        range: {
          start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
          end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
        },
        severity: markerSeverityToLsp(m.severity),
        message: m.message,
        source: m.source,
      }));
      try {
        const result: LspCodeAction[] | null = await request("textDocument/codeAction", {
          textDocument: { uri: pathToFileUri(currentPath(model)) },
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
          context: { diagnostics },
        });
        if (Array.isArray(result)) {
          for (const a of result) {
            // PR-O：抑制产出坏代码的引擎动作（extract helper 漏 return，探针报告为准）
            if (isSuppressedEngineAction(a.title)) continue;
            const edits = codeActionEditToMonaco(a.edit, model);
            // 只处理有 edit 的 CodeAction；纯 command 类型暂不支持
            if (edits.length === 0 && !a.edit) continue;
            actions.push({
              title: a.title,
              kind: a.kind,
              diagnostics: [],
              edit: { edits },
              isPreferred: a.isPreferred ?? false,
            });
          }
        }
      } catch {
        // LSP codeAction 失败不影响安装动作
      }
      return { actions, dispose: () => {} };
    },
  });
}

// ---------- Inlay Hints（运行时类型标注，P3-T07） ----------

interface LspInlayHint {
  position: LspPosition;
  label: string | Array<{ value: string }>;
  kind?: number; // 1 = Type, 2 = Parameter
  paddingLeft?: boolean;
  paddingRight?: boolean;
  tooltip?: unknown;
}

/**
 * PR-N：把 inlay hints 配置推给静态引擎（`workspace/didChangeConfiguration`）。
 * 只推 `callArgumentNames`——变量/返回类型提示是引擎默认开的能力，不在此关掉，
 * 免得「关参数名提示」的开关顺手把类型提示也灭了（职责最小化）。
 * 调用点：startEngine 就绪后 + 设置保存后（settingsPanel）。
 */
/**
 * PR-N：设置变更后通知 Monaco 重新拉取提示——否则它会一直沿用缓存结果直到下次编辑。
 * ⚠ 必须延迟到 registerLspInlayHints 里创建：模块级 `monaco` 是后赋值的引用
 *   （顶层 new monaco.Emitter() 会炸，且 TS 报 used before assigned）。
 */
let inlayHintsChanged: MonacoApi.Emitter<void> | null = null;

export function pushInlayHintSettings(): Promise<void> {
  if (session("static").status !== "ready") return Promise.resolve();
  void Promise.resolve().then(() => inlayHintsChanged?.fire()); // 下一微任务刷，避免与推送竞态
  return notifyEngine("static", "workspace/didChangeConfiguration", {
    settings: {
      python: {
        analysis: {
          inlayHints: { callArgumentNames: app.settings.inlay_param_hints !== false ? "all" : "off" },
        },
      },
    },
  });
}

/** 单源查询 inlay hints（未就绪/失败返回空数组，绝不打断另一个源） */
async function queryInlays(engine: string, params: unknown): Promise<LspInlayHint[]> {
  if (session(engine).status !== "ready") return [];
  try {
    const items = (await requestEngine(engine, "textDocument/inlayHint", params)) as LspInlayHint[];
    return Array.isArray(items) ? items : [];
  } catch {
    return []; // 单源失败静默：inlay 是增强信息，不值得弹错
  }
}

/**
 * 注册 inlay hints provider：**双源**——
 *   · 静态引擎（PR-N）：参数名提示（`name=`），受 `inlay_param_hints` 开关控制；
 *   · 运行时引擎 intel：运行时类型标注（P3-T07 既有能力，不受本开关影响）。
 * 同位置同文案去重（两源理论上不重叠，但换引擎/切 intel 期间可能短暂并存）。
 */
export function registerLspInlayHints(): MonacoApi.IDisposable {
  inlayHintsChanged = new monaco.Emitter<void>();
  return monaco.languages.registerInlayHintsProvider("python", {
    // PR-N：设置开关要即时生效（Monaco 默认缓存 provider 结果直到下次编辑）
    onDidChangeInlayHints: inlayHintsChanged.event,
    async provideInlayHints(model: MonacoApi.editor.ITextModel, range: MonacoApi.IRange) {
      const params = {
        textDocument: { uri: pathToFileUri(currentPath(model)) },
        range: {
          start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
          end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
        },
      };
      const K = monaco.languages.InlayHintKind;
      const wantStatic = engineStatus === "ready" && app.settings.inlay_param_hints !== false;
      const [staticItems, intelItems] = await Promise.all([
        wantStatic ? queryInlays("static", params) : Promise.resolve([]),
        queryInlays("intel", params),
      ]);
      const seen = new Set<string>();
      const hints: MonacoApi.languages.InlayHint[] = [];
      for (const h of [...intelItems, ...staticItems]) {
        const label = typeof h.label === "string" ? h.label : h.label.map((p) => p.value).join("");
        const pos = lspPosToMonaco(h.position);
        const key = `${pos.lineNumber}:${pos.column}:${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push({
          position: pos,
          label,
          kind: h.kind === 2 ? K.Parameter : K.Type,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
          tooltip: typeof h.tooltip === "string" ? h.tooltip : undefined,
        });
      }
      hints.sort((a, b) => a.position.lineNumber - b.position.lineNumber || a.position.column - b.position.column);
      return { hints, dispose: () => {} };
    },
  });
}

// ---------- 诊断 ----------

/** CR-22：诊断缓存 key 归一化（\→/ + lowercase）。
 * 原来 key 用 `fileUriToPath` 结果与 `tab.path` 严格 `===`，Windows 大小写/分隔符
 * 不一致时红波浪线静默不显示（极难排查）。归一化 key + 存原始 path 供回放。 */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** 诊断缓存：normPath → (owner → { 原始 path, markers })。不同引擎（pyrefly / pylume-intel）分 owner 并存显示 */
const diagnosticsCache = new Map<string, Map<string, { path: string; markers: MonacoApi.editor.IMarkerData[] }>>();

/** 静态引擎切换时只清引擎自己的诊断桶（pylume-lsp），自研桶（intel / pydantic / ruff）
 *  不随引擎重启失效——它们与静态引擎生命周期无关（阶段 4 子项 1c）。 */
function clearEngineDiagnostics(): void {
  for (const [norm, byOwner] of diagnosticsCache) {
    byOwner.delete("pylume-lsp");
    if (byOwner.size === 0) diagnosticsCache.delete(norm);
  }
}

/** 引擎就绪后重放非引擎桶的缓存诊断（applyCachedDiagnostics 按全 owner 回放，
 *  引擎桶清空后自然只剩自研桶；main 在 onEngineStatus ready 时对已打开 tab 调用）。 */
export function replayPersistentDiagnostics(
  setMarkers: (path: string, markers: MonacoApi.editor.IMarkerData[], owner?: string) => void,
  openedPaths: string[],
): void {
  for (const p of openedPaths) applyCachedDiagnostics(p, setMarkers);
}

export function handleDiagnostics(
  params: { uri: string; diagnostics: LspDiagnostic[] },
  engine: string | undefined,
  setMarkers: (path: string, markers: MonacoApi.editor.IMarkerData[], owner?: string) => void,
): void {
  const path = fileUriToPath(params.uri);
  const owner = engine === "intel" ? "pylume-intel" : "pylume-lsp";
  // 去重（2026-09-29 实测）：pyrefly 单批内会对同一位置重复推送同形态诊断
  //（实案：`Unpacked keyword argument` 一条消息 ×19 份同 range），不去重时 hover
  // 列表 / 问题面板 / 保存 toast 计数全部虚高，squiggle 也因同 range 装饰互相
  // 压盖只渲染一条。键 = range + severity + code + message（任一不同即视为独立诊断）。
  const seen = new Set<string>();
  const markers: MonacoApi.editor.IMarkerData[] = [];
  for (const d of params.diagnostics) {
    const code = typeof d.code === "string" ? d.code : d.code !== undefined ? String(d.code) : undefined;
    const m: MonacoApi.editor.IMarkerData = {
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      // PyCharm 语义降级（2026-09-29 用户实案反馈）：pyrefly typeCheckingMode=default 把
      // 大量类型检查问题判为 error（实测 203 条中仅 23 条 parse-error，其余 145 条 error
      // 是 bad-function-definition / bad-argument-type / missing-attribute 等——PyCharm 里
      // 均为警告级）。红线只留给「代码跑不起来/名字解析不了」的硬错误，类型问题降黄线。
      severity: severityForEngine(d.severity, code),
      source: d.source ?? currentEngine,
      code,
    };
    const key = `${m.startLineNumber}:${m.startColumn}-${m.endLineNumber}:${m.endColumn}|${m.severity}|${m.code ?? ""}|${m.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push(m);
  }
  let byOwner = diagnosticsCache.get(normPath(path));
  if (!byOwner) {
    byOwner = new Map();
    diagnosticsCache.set(normPath(path), byOwner);
  }
  byOwner.set(owner, { path, markers: capMarkersBySeverity(markers) });
  setMarkers(path, byOwner.get(owner)!.markers, owner);
}

/** 硬错误 code（保留 Error 级 / 红线）：代码无法运行或名字解析失败。
 *  code 兼容两引擎：pyrefly 短横线风格（parse-error / missing-import / unbound-name）；
 *  basedpyright 的 reportUndefinedVariable / reportGeneralTypeIssues 等「运行即炸」类。
 *  注：missing-import 在 PyCharm 是硬错误（运行必 ImportError）——保留红线。 */
const HARD_ERROR_CODES: ReadonlySet<string> = new Set([
  "parse-error", "missing-import", "missing-module", "unbound-name",
  "reportUndefinedVariable", "reportGeneralTypeIssues",
]);

/** LSP severity → Monaco severity（PyCharm 语义）：
 *  · LSP error + 硬错误 code → Error（红线）
 *  · LSP error + 类型检查类 code → Warning（黄线，PyCharm 同款分级）
 *  · LSP warning 以下原样映射 */
// 修（2026-09-30）：返回类型原写作 `monaco.MarkerSeverity`——模块级变量 `monaco` 不是
// 命名空间，类型位置报 TS2503。类型用 `MonacoApi.MarkerSeverity`（type-only 导入的
// 命名空间，类型位置合法）；返回**值**仍取运行时注入的 `monaco`（诊断路径必然已
// setMonaco——引擎就绪才有诊断进来）。
function severityForEngine(lspSeverity: number | undefined, code: string | undefined): MonacoApi.MarkerSeverity {
  if (lspSeverity === 1) {
    return code !== undefined && HARD_ERROR_CODES.has(code)
      ? monaco.MarkerSeverity.Error
      : monaco.MarkerSeverity.Warning;
  }
  return lspSeverity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info;
}

/** Monaco markerDecorationsService 的渲染硬上限：每 model 只取前 500 条 marker 建装饰
 *  （markerDecorationsService.js `_updateDecorations` 的 `take: 500`），**按 marker service
 *  内部插入序**截断——大文件实案（hermes-agent/cli.py，851 条：169 error + 682 warning）
 *  中 75 行的 missing-import error 排在 500 名后 → 无装饰 → 无红线，而早期插入的
 *  warning 恰在前 500 → 有黄线，表现为「警告有线、错误没线」（2026-09-29 真实环境
 *  CDP 取证定位）。注入前按 severity 分层截断（Error 全保留 > Warning > Info > Hint），
 *  保证 error 永远进入渲染窗口。阈值 450：留 50 余量给其他 owner 桶（ruff/pydantic/
 *  libs——它们也走同一 model 的 marker service，合并后仍受 500 截断）。 */
const MARKER_RENDER_CAP = 450;
export function capMarkersBySeverity(markers: MonacoApi.editor.IMarkerData[], cap = MARKER_RENDER_CAP): MonacoApi.editor.IMarkerData[] {
  if (markers.length <= cap) return markers;
  // MarkerSeverity 稳定数字枚举（monaco 0.52：Hint=1 / Info=2 / Warning=4 / Error=8）——
  // 不读注入的 monaco 实例（本函数可能在 setMonaco 之前的测试路径被直接调用）
  const bySev = new Map<number, MonacoApi.editor.IMarkerData[]>();
  for (const m of markers) {
    const arr = bySev.get(m.severity) ?? [];
    arr.push(m);
    bySev.set(m.severity, arr);
  }
  const out: MonacoApi.editor.IMarkerData[] = [];
  for (const sev of [8, 4, 2, 1]) {
    const arr = bySev.get(sev);
    if (!arr) continue;
    if (out.length >= cap) break;
    out.push(...arr.slice(0, cap - out.length));
  }
  return out;
}

/** 打开文件时应用缓存的诊断（若引擎已发布过该文件的诊断） */
export function applyCachedDiagnostics(
  path: string,
  setMarkers: (path: string, markers: MonacoApi.editor.IMarkerData[], owner?: string) => void,
): void {
  const byOwner = diagnosticsCache.get(normPath(path));
  if (!byOwner) return;
  for (const [owner, entry] of byOwner) setMarkers(entry.path, entry.markers, owner);
}

/** CR-22：didClose 删对应缓存条目（关文件即释放，不再等引擎重启才清） */
export function discardCachedDiagnostics(path: string): void {
  diagnosticsCache.delete(normPath(path));
}

/** CR-22：诊断缓存 key 迁移（P25-T03 重命名联动：旧路径 → 新路径） */
export function migrateDiagnostics(oldPath: string, newPath: string): void {
  const cached = diagnosticsCache.get(normPath(oldPath));
  if (cached !== undefined) {
    diagnosticsCache.delete(normPath(oldPath));
    diagnosticsCache.set(normPath(newPath), cached);
  }
}
