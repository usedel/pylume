// 调试断点 gutter（docs/python_debug_dev_plan.md §6.4）：glyphMargin 红点装饰 + 点击切换。
// 复用 runGutter.ts 的装饰/命中范式，但独立一套装饰集合（勿与 run gutter 冲突）。
//
// 断点数据源：模块级 Map<filePath, Map<lineNumber, BreakpointSpec>>；调试会话期间同步到
// debugger（setBreakpoints 请求），停止调试后断点表保留（下次调试自动重放，D3 验收项）。
//
// P0（PyCharm 调研 N/D2/D3）：断点不再只有行号——每行可挂 condition / hitCondition /
// logMessage 三个 DAP 原生字段（见 dap/client.ts 的 BreakpointSpec 注释）。
// 数据结构由 Set<line> 升级为 Map<line, spec>：**空 spec 即普通断点**，
// 故既有「只有行号」的调用方（getBreakpointLines / setBreakpointLines）语义不变。
//
// P2-11（UX 审查）：断点表随工作区持久化（<data_root>/breakpoints/<hash>.json，与书签同模式）。
// 每次断点表变更经 notifyChange 全量落盘（fire-and-forget，失败 toast 不阻断交互）；
// 打开工作区时 loadBreakpoints 回填内存表，切换/关闭工作区时 resetBreakpoints 清内存（不写盘）。

import { invoke } from "@tauri-apps/api/core";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, type MonacoModule } from "./state";
import * as dap from "./dap/client";
import type { BreakpointKind, BreakpointSpec, DapSourceBreakpoint } from "./dap/client";
import { toastFail } from "./toast";
import { t } from "./i18n"; // 第十三批 i18n：动态文案走语言包

/** 断点表：文件路径 → 行号 → 高级属性（空对象 = 普通断点）。模块级持久（跨会话保留，D3 验收）。 */
const breakpoints = new Map<string, Map<number, BreakpointSpec>>();

let decorations: MonacoApi.editor.IEditorDecorationsCollection | null = null;
let editorRef: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let monacoRef: MonacoModule | null = null;

/**
 * 「该行是否被 runGutter 的 ▶ 占用」判定，由 main.ts 注入（`runGutter.isRunGutterLine`）。
 * 走注入而非直接 import runGutter：避免把 runGutter → menu 的传递依赖带进本模块
 * （menu.ts 在模块顶层注册 document 级监听，测试环境会因缺 #ctx-menu 抛错）。
 * 未注入时恒 false（不过滤），此时本模块的 glyph 点击也不会被 wire 上，行为不受影响。
 */
let isRunLine: (line: number) => boolean = () => false;

/** 断点表变更回调（debugView 注册：gutter 点击 / 列表删除后刷新侧栏断点列表） */
let onChange: (() => void) | null = null;

/** 注册断点表变更回调（幂等：后者覆盖前者） */
export function setBreakpointsChangeCallback(cb: (() => void) | null): void {
  onChange = cb;
}

function notifyChange(): void {
  onChange?.();
  persistBreakpoints(); // P2-11：所有变更路径统一在此落盘
}

// ---------- 持久化（P2-11：与书签同模式，工作区级 JSON） ----------

/** 落盘形态（Rust PersistedBreakpoint，camelCase 对齐；空串 = 无该高级属性） */
interface PersistedBreakpoint {
  path: string;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  enabled?: boolean;
}

/** 全量覆盖写盘（fire-and-forget；invoke 参数在调用点同步捕获，切换工作区无竞态） */
function persistBreakpoints(): void {
  const root = app.workspaceRoot;
  if (!root) return;
  const list: PersistedBreakpoint[] = [];
  for (const [path, map] of breakpoints) {
    for (const [line, spec] of map) {
      list.push({
        path,
        line,
        condition: spec.condition ?? "",
        hitCondition: spec.hitCondition ?? "",
        logMessage: spec.logMessage ?? "",
        enabled: spec.enabled !== false, // B-6
      });
    }
  }
  try {
    // fire-and-forget：落盘失败只提示，绝不打断 gutter 点击（invoke 同步异常也不冒泡到交互路径）
    void Promise.resolve(invoke("set_breakpoints", { workspaceRoot: root, breakpoints: list })).catch((e) => {
      console.warn("[debugGutter] 断点落盘失败", e);
      toastFail(t("ide.bg.failSave"), e);
    });
  } catch (e) {
    console.warn("[debugGutter] 断点落盘失败", e);
    toastFail(t("ide.bg.failSave"), e);
  }
}

/** 打开工作区时回填内存表（空串高级属性归一为 undefined，保持「空 spec 即普通断点」） */
export async function loadBreakpoints(): Promise<void> {
  if (!app.workspaceRoot) return;
  try {
    const list = await invoke<PersistedBreakpoint[]>("get_breakpoints", { workspaceRoot: app.workspaceRoot });
    breakpoints.clear();
    for (const b of list) {
      let map = breakpoints.get(b.path);
      if (!map) {
        map = new Map();
        breakpoints.set(b.path, map);
      }
      const spec: BreakpointSpec = {};
      if (b.condition) spec.condition = b.condition;
      if (b.hitCondition) spec.hitCondition = b.hitCondition;
      if (b.logMessage) spec.logMessage = b.logMessage;
      if (b.enabled === false) spec.enabled = false; // B-6：旧快照无此字段 = 启用
      map.set(b.line, spec);
    }
    // 回填后刷新侧栏断点列表——否则打开工作区后旧断点只在 gutter 可见，列表却是空的
    //（gutter 装饰由调用方 refreshDebugGutter 负责；走 onChange 而非 notifyChange，避免多余回写盘）
    onChange?.();
  } catch (e) {
    console.warn("[debugGutter] 读取断点失败", e);
    toastFail(t("ide.bg.failLoad"), e);
  }
}

/** 切换/关闭工作区时清空内存表（盘上数据属于各自工作区，不写盘） */
export function resetBreakpoints(): void {
  breakpoints.clear();
}

/** 取某文件断点行（排序副本） */
export function getBreakpointLines(path: string): number[] {
  const map = breakpoints.get(path);
  if (!map) return [];
  return [...map.keys()].sort((a, b) => a - b);
}

/** 取某文件全部断点（含高级属性，按行排序；setBreakpoints 推送用） */
export function getBreakpoints(path: string): DapSourceBreakpoint[] {
  return getBreakpointLines(path).map((line) => ({ line, ...(breakpoints.get(path)?.get(line) ?? {}) }));
}

/** 取单个断点的高级属性；该行无断点返回 null */
export function getBreakpointSpec(path: string, line: number): BreakpointSpec | null {
  return breakpoints.get(path)?.get(line) ?? null;
}

/** 断点类型判定（gutter 图标与断点列表徽标共用）：log 优先于 condition */
export function breakpointKind(spec: BreakpointSpec | null): BreakpointKind {
  if (!spec) return "plain";
  if (spec.logMessage) return "log";
  if (spec.condition || spec.hitCondition) return "condition";
  return "plain";
}

/** 全部断点文件路径（会话启动时批量推送用，§5.3 启动时序） */
export function breakpointFiles(): string[] {
  return [...breakpoints.keys()];
}

/** 是否存在任一断点 */
export function hasAnyBreakpoint(): boolean {
  for (const map of breakpoints.values()) {
    if (map.size > 0) return true;
  }
  return false;
}

/** 切换断点（gutter 点击）；返回切换后的状态（true = 已设断点） */
export function toggleBreakpoint(path: string, line: number): boolean {
  let map = breakpoints.get(path);
  if (!map) {
    map = new Map();
    breakpoints.set(path, map);
  }
  if (map.has(line)) {
    map.delete(line);
    if (map.size === 0) breakpoints.delete(path);
    syncBreakpointsToDebugger(path);
    notifyChange();
    return false;
  }
  map.set(line, {});
  syncBreakpointsToDebugger(path);
  notifyChange();
  return true;
}

/** 清空某文件全部断点 */
export function clearBreakpoints(path: string): void {
  if (!breakpoints.has(path)) return;
  breakpoints.delete(path);
  syncBreakpointsToDebugger(path);
  notifyChange();
}

/** 删除单行断点（断点列表删除按钮 / 右键菜单用） */
export function removeBreakpoint(path: string, line: number): void {
  const map = breakpoints.get(path);
  if (!map?.has(line)) return;
  map.delete(line);
  if (map.size === 0) breakpoints.delete(path);
  syncBreakpointsToDebugger(path);
  notifyChange();
}

/**
 * 直接设置某文件的断点行集合（断点列表删除单行用；完成后同步到 debugger）。
 * 保留仍在列表中的行原有的高级属性——删除单行不该把同文件其它条件断点清成普通断点。
 */
export function setBreakpointLines(path: string, lines: number[]): void {
  if (lines.length === 0) {
    breakpoints.delete(path);
  } else {
    const old = breakpoints.get(path);
    const next = new Map<number, BreakpointSpec>();
    for (const l of lines) next.set(l, old?.get(l) ?? {});
    breakpoints.set(path, next);
  }
  syncBreakpointsToDebugger(path);
  notifyChange();
}

/** 写入/合并单个断点的高级属性（行上无断点时自动创建）；传 null spec 即清空为普通断点 */
export function updateBreakpoint(path: string, line: number, spec: BreakpointSpec | null): void {
  let map = breakpoints.get(path);
  if (!map) {
    map = new Map();
    breakpoints.set(path, map);
  }
  map.set(line, spec ?? {});
  syncBreakpointsToDebugger(path);
  notifyChange();
}

/**
 * 设置断点启用/禁用（B-6）。
 * 禁用的断点保留在表里（gutter 灰点、面板可见）但**不下发 debugger**——
 * 启用时重新 sync 即恢复生效，条件/日志属性原样保留。
 */
export function setBreakpointEnabled(path: string, line: number, enabled: boolean): void {
  const spec = breakpoints.get(path)?.get(line);
  if (!spec) return;
  if (enabled) delete spec.enabled;
  else spec.enabled = false;
  syncBreakpointsToDebugger(path);
  notifyChange();
}

/** 单个断点是否启用（缺省 = 启用；gutter/面板渲染与菜单文案共用） */
export function isBreakpointEnabled(spec: BreakpointSpec | null): boolean {
  return spec?.enabled !== false;
}

/**
 * 同步单文件断点到 debugger（§6.4：断点变化 → setBreakpoints）。
 * 仅在会话存活期间发送（starting/running/stopped 均可：暂停态增删断点同样生效）。
 */
export async function syncBreakpointsToDebugger(path: string): Promise<void> {
  const phase = dap.currentPhase();
  if (phase === "idle" || phase === "exited") return;
  try {
    await dap.dapSetBreakpoints(path, getBreakpoints(path));
  } catch (e) {
    console.warn("[debugGutter] setBreakpoints 失败:", e);
  }
}

/** 全量重放断点（会话启动时 configurationDone 之前调用，§5.3 启动时序） */
export async function pushAllBreakpoints(): Promise<void> {
  for (const path of breakpointFiles()) {
    try {
      await dap.dapSetBreakpoints(path, getBreakpoints(path));
    } catch (e) {
      console.warn("[debugGutter] setBreakpoints（重放）失败:", e);
    }
  }
}

/**
 * 断点 gutter 右键菜单回调（由 main.ts 注入）。
 * 走注入而非直接 import menu.ts：menu.ts 在模块顶层解析 #ctx-menu（lazyEl 取不到即抛），
 * 本模块被断点相关单测直接 import —— 未注入时右键静默无动作，测试与生产行为都不受影响。
 */
let onContextMenu: ((path: string, line: number, x: number, y: number) => void) | null = null;

/** 注册断点右键菜单回调（幂等：后者覆盖前者） */
export function setBreakpointMenuHandler(
  fn: ((path: string, line: number, x: number, y: number) => void) | null,
): void {
  onContextMenu = fn;
}

export function wireDebugGutter(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  monaco: MonacoModule,
  isRunGutterLine: (line: number) => boolean,
): void {
  editorRef = editor;
  monacoRef = monaco;
  isRunLine = isRunGutterLine;
  // glyphMargin 点击切换断点（仅 .py/.pyw，与 runGutter 一致；§6.4）
  editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber;
    if (!line) return;
    const tab = app.activeTab;
    if (!tab) return;
    const isPy = tab.path.endsWith(".py") || tab.path.endsWith(".pyw");
    if (!isPy) return;
    // ▶ 占用的守卫行由 runGutter 的同类 handler 处理；Monaco onMouseDown 多订阅不可阻断，
    // 故此处显式让出，否则同一次点击会「既运行又设断点」，红点装饰还会盖掉 ▶（方案 A）。
    if (isRunLine(line)) return;
    // 右键 → 断点菜单（P0：条件断点 / 命中次数 / Logpoint）。
    // 不切换断点状态：右键是「设置」语义，误触不应删掉已有断点。
    // 坐标取法与 runGutter 一致：优先浏览器原生 clientX/Y（视口坐标，与 menu.ts 的
    // innerWidth/innerHeight 收敛同基准），Monaco 的 posx/posy（页面坐标）仅作兜底。
    if (e.event.rightButton) {
      const bx = e.event.browserEvent?.clientX ?? e.event.posx;
      const by = e.event.browserEvent?.clientY ?? e.event.posy;
      onContextMenu?.(tab.path, line, bx, by);
      return;
    }
    toggleBreakpoint(tab.path, line);
    refreshDebugGutter();
  });
}

/** 断点类型 → glyph 装饰类名（普通红点 / 条件红点带问号 / Logpoint 菱形 / 禁用灰点） */
function breakpointGlyphClass(spec: BreakpointSpec | null): string {
  const base = breakpointKind(spec);
  const disabled = !isBreakpointEnabled(spec);
  switch (base) {
    case "log":
      return disabled ? "gutter-breakpoint gutter-breakpoint-log gutter-breakpoint-disabled" : "gutter-breakpoint gutter-breakpoint-log";
    case "condition":
      return disabled ? "gutter-breakpoint gutter-breakpoint-cond gutter-breakpoint-disabled" : "gutter-breakpoint gutter-breakpoint-cond";
    default:
      return disabled ? "gutter-breakpoint gutter-breakpoint-disabled" : "gutter-breakpoint";
  }
}

/** 重算当前文件的断点红点装饰（切 tab / 内容变化 / 断点切换后调用） */
export function refreshDebugGutter(): void {
  clearDebugGutter();
  const editor = editorRef;
  const monaco = monacoRef;
  if (!editor || !monaco) return;
  const tab = app.activeTab;
  if (!tab) return;
  const isPy = tab.path.endsWith(".py") || tab.path.endsWith(".pyw");
  if (!isPy) return;
  // 过滤掉 ▶ 占用的守卫行：断点表跨会话持久，若有历史断点落在该行，
  // 其红点装饰会压过 ▶（style.css 中 .gutter-breakpoint::after 书写在后），故不渲染。
  const bps = getBreakpoints(tab.path).filter((b) => !isRunLine(b.line));
  if (bps.length === 0) return;
  decorations = editor.createDecorationsCollection(
    bps.map((b) => ({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: {
        glyphMarginClassName: breakpointGlyphClass(b),
        // 悬停可见条件/日志内容（gutter 空间有限，全文交给 tooltip）
        glyphMarginHoverMessage: { value: breakpointHoverText(b) },
      },
    })),
  );
}

/** 断点悬停文本（gutter hover）：条件 / 命中次数 / Logpoint 消息 */
function breakpointHoverText(b: DapSourceBreakpoint): string {
  const parts: string[] = [];
  if (b.condition) parts.push(t("ide.bg.tipCondition", { condition: b.condition }));
  if (b.hitCondition) parts.push(t("ide.bg.tipHit", { hit: b.hitCondition }));
  if (b.logMessage) parts.push(t("ide.bg.tipLog", { message: b.logMessage }));
  if (parts.length === 0) return t("ide.bg.tipBreakpoint");
  return parts.join("\n\n");
}

/** 清空断点装饰（关闭 tab / 非 .py / 切工作区；断点表数据不动） */
export function clearDebugGutter(): void {
  decorations?.clear();
  decorations = null;
}

/** 关闭文件：若该文件无断点则无操作；有断点保留（表跨会话持久），仅清装饰 */
export function onFileClosed(path: string): void {
  void path; // 断点表保留（D3 验收：停止调试后断点表保留，下次自动重放）
}

// ---------- 当前行高亮（§6.5：stopped 事件 → current-line 装饰） ----------

let currentLineDecorations: MonacoApi.editor.IEditorDecorationsCollection | null = null;

/** 标示当前执行行（每次 stopped 先 clear 再设，§6.4/D4） */
export function highlightCurrentLine(path: string, line: number): void {
  clearCurrentLine();
  const editor = editorRef;
  const monaco = monacoRef;
  if (!editor || !monaco) return;
  const tab = app.activeTab;
  if (!tab || tab.path !== path) return; // 只高亮当前打开的文件
  currentLineDecorations = editor.createDecorationsCollection([
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "debug-current-line",
        linesDecorationsClassName: "debug-current-line-margin",
        overviewRuler: { color: "#F5C518", position: monaco.editor.OverviewRulerLane.Center },
      },
    },
  ]);
}

/** 清除当前行高亮（继续执行 / 会话结束时） */
export function clearCurrentLine(): void {
  currentLineDecorations?.clear();
  currentLineDecorations = null;
}

// ---------- E2E 调试测试钩子（仅 vite dev，不影响生产构建/行为）----------
// 复刻真实 gutter 点击进入的同一条 toggleBreakpoint 逻辑，供 Playwright 确定性地下断点，
// 规避 headless 下 Monaco glyph-margin 像素点击的命中抖动；gutter 点击本身由 D-FUNC-1 单点覆盖。
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __OC_DEBUG_TEST__?: unknown }).__OC_DEBUG_TEST__ = {
    toggleActive(line: number) {
      const tab = app.activeTab;
      if (!tab) return false;
      toggleBreakpoint(tab.path, line);
      refreshDebugGutter(); // 真实 gutter 点击在 onMouseDown 中也会显式刷新装饰
      return true;
    },
    list() {
      const out: Record<string, number[]> = {};
      for (const [p, m] of breakpoints.entries()) out[p] = Array.from(m.keys());
      return out;
    },
  };
}
