// 调试侧栏（docs/python_debug_dev_plan.md §6.5）：工具栏 / 调用栈 / 变量 / 断点列表。
// 对标 runWidget 的 handlers 注入模式：main.ts 拥有调试动作（启动/停止），本模块负责
// 渲染与步进派发；DAP 数据流经 dap/client（stopped → threads/stackTrace/scopes/variables）。

import * as dap from "./dap/client";
import type { DapStackFrame, DapVariable } from "./dap/client";
import {
  getBreakpoints, getBreakpointSpec, removeBreakpoint, breakpointFiles, breakpointKind,
  clearCurrentLine, highlightCurrentLine, setBreakpointsChangeCallback, syncBreakpointsToDebugger, updateBreakpoint,
  isBreakpointEnabled, setBreakpointEnabled,
} from "./debugGutter";
import type { DapSourceBreakpoint } from "./dap/client";
import { openPrompt } from "./dialog";
import { clearInlineValues, updateInlineValues } from "./inlineValues";
import { clearWatchesValues, initWatchesPanel, refreshWatches } from "./debugWatches"; // B-1
import { $ } from "./state";
import { codicon, basename, emptyState, spinIcon } from "./util"; // UI-12：空态改用统一组件
import { toastFail } from "./toast";
import { onLocaleChange, t, type TFuncKey } from "./i18n";
// UI-09：工具栏提示的快捷键副文本改为读键位系统（原先把 "(F5)" 等硬编码进提示文本，
// 用户在设置里改键后提示就是错的）。keybindings 仅依赖 state，此处导入不成环。
import { bindingLabel, type KeybindingId } from "./keybindings";

// ---------- handlers 注入（同 runWidget 先例，避免循环导入） ----------

export interface DebugViewHandlers {
  /** 启动调试（工具栏 F5 同款入口） */
  start: () => void;
  /** 停止调试 */
  stop: () => void;
  /** 点击调用栈帧 → 打开源码并定位（main.ts 的 openFile） */
  openFile: (path: string, line: number) => void;
  /** 重建断点装饰（删除断点后） */
  refreshGutter: () => void;
}

let handlers: DebugViewHandlers | null = null;

export function setDebugViewHandlers(h: DebugViewHandlers): void {
  handlers = h;
}

// ---------- 状态（§6.5 状态机映射） ----------

let activeThreadId = 1;
let activeFrameId: number | null = null;
let activeFrames: DapStackFrame[] = [];
/** B-7：变量值显示截断与展开深度上限（完整值挂 title；防止巨型对象拖垮侧栏） */
const MAX_VAR_VALUE_LEN = 200;
const MAX_VAR_DEPTH = 5;
/** 当前帧的 locals 变量（P2：行内变量值 / Set Value 都要用） */
let activeVars: DapVariable[] = [];
/** locals 容器的引用（setVariable 需要「容器 + 名字」，不是变量自身） */
let activeScopeRef = 0;
/** P2-11（UX 审查）：已展开的容器引用集合——单次 stopped 内有效（ref 随会话/帧失效，
 *  handleStopped 清空；setValue 触发的刷新据此重渲染已展开的子树，展开状态不丢） */
const expandedRefs = new Set<number>();
/** 变量面板异步令牌（CR-20 范式）：旧 stopped 的 scopes/variables 响应不得覆盖新面板 */
let varToken = 0;

/**
 * Run to Cursor 的临时断点（P2）。
 * `hadBefore` 记录该行原本是否已有断点——临时断点用完即撤，但不能把用户自己
 * 设的断点一并删掉（否则「跑到光标」会顺手吃掉一个断点，很难被察觉）。
 */
let tempBreakpoint: { path: string; line: number; hadBefore: boolean } | null = null;

/**
 * 当前选中栈帧 id（P1：调试控制台求值要用——表达式须在**选中帧**的上下文里求值，
 * 否则用户点了调用栈第 3 帧却在栈顶帧里求值，结果会与所见不符）。
 */
export function currentFrameId(): number | null {
  return activeFrameId;
}

/** 记录「依赖清单命中 debugpy」的一次性提示是否已发（§3.5：输出面板一次性提示） */
let depNoticeShown = false;
/** 初始化只允许一次：语言切换只刷新已有 DOM，不能再次清空侧栏或重复接入 Watches。 */
let debugViewInitialized = false;

export function notifyDepFound(files: string[]): void {
  if (depNoticeShown || files.length === 0) return;
  depNoticeShown = true;
  const list = files.join("、");
  console.info(`[debug] 项目依赖清单（${list}）声明了 debugpy：Pylume 调试使用自带副本，二者互不影响，可按需移除声明。`);
}

// ---------- 渲染 ----------

/** 工具栏提示元数据：base 文案 + 可选键位 id。
 *  「继续」复用键位 `debug`（其语义即「启动调试 / 继续」，与工具栏同一动作）；「暂停」无快捷键。 */
const TOOLBAR_TIPS: Record<string, { key: TFuncKey; kbId: KeybindingId | null }> = {
  "debug-continue": { key: "debug.toolbar.continue", kbId: "debug" },
  "debug-pause": { key: "debug.toolbar.pause", kbId: null },
  "debug-step-over": { key: "debug.toolbar.stepOver", kbId: "debug_step_over" },
  "debug-step-into": { key: "debug.toolbar.stepInto", kbId: "debug_step_into" },
  "debug-step-out": { key: "debug.toolbar.stepOut", kbId: "debug_step_out" },
  "debug-stop": { key: "debug.toolbar.stop", kbId: "debug_stop" },
};

/** 写入 tooltip 文案 + kbd 副文本 + aria-label（每次渲染工具栏都刷新，故改键后下次渲染即生效） */
function applyToolbarTip(btn: HTMLElement, id: string): void {
  const meta = TOOLBAR_TIPS[id];
  if (!meta) return;
  const key = meta.kbId ? bindingLabel(meta.kbId) : "";
  const tip = t(meta.key);
  btn.dataset.tip = tip;
  // 副文本为空时删除属性：tooltip.ts 以 `if (key)` 判断，残留空串会渲染出空 kbd 框
  if (key) btn.dataset.tipKey = key;
  else delete btn.dataset.tipKey;
  btn.setAttribute("aria-label", key ? `${tip} ${key}` : tip);
}

function toolbarButton(id: string, icon: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = id;
  btn.className = "debug-toolbar-btn";
  // UI-09：图标按钮统一走自绘 data-tip。内部 <i> 带 aria-hidden，可访问名称原先仅由 title
  // 提供，故同步补 aria-label（由 applyToolbarTip 写入）。
  applyToolbarTip(btn, id);
  btn.appendChild(codicon(icon));
  // UI-09：以 .is-disabled + aria-disabled 取代 disabled 属性。原因：Chromium 不向禁用的表单
  // 控件派发鼠标事件（事件落到父元素），data-tip 会静默失效；而「未调试时整排灰按钮」恰是
  // 最需要提示的场景（原生 title 由渲染层命中测试驱动，禁用态仍显示，故不能简单替换）。
  // 附带收益：按钮保留在 tab 序列内，键盘/读屏用户能发现控件并听到「已禁用」状态
  //（disabled 属性会把元素移出焦点序列，等于对键盘用户完全隐藏）。
  btn.addEventListener("click", () => {
    if (btn.classList.contains("is-disabled")) return;
    onClick();
  });
  return btn;
}

/** 初始化调试侧栏 DOM（init 时一次性构建；#view-debug 容器已在 index.html 声明） */
export function initDebugView(): void {
  if (debugViewInitialized) return;
  debugViewInitialized = true;
  const root = $("view-debug");
  root.textContent = "";

  // 工具栏（§6.1：继续/暂停/单步跳过/单步进入/单步退出/停止）
  // UI-09：提示文案与快捷键改由 TOOLBAR_TIPS + 键位系统提供，此处只传 id / 图标 / 动作
  const toolbar = document.createElement("div");
  toolbar.id = "debug-toolbar";
  toolbar.appendChild(toolbarButton("debug-continue", "debug-continue", () => void onContinue()));
  toolbar.appendChild(toolbarButton("debug-pause", "debug-pause", () => void onPause()));
  toolbar.appendChild(toolbarButton("debug-step-over", "debug-step-over", () => void onStep("next")));
  toolbar.appendChild(toolbarButton("debug-step-into", "debug-step-into", () => void onStep("stepIn")));
  toolbar.appendChild(toolbarButton("debug-step-out", "debug-step-out", () => void onStep("stepOut")));
  toolbar.appendChild(toolbarButton("debug-stop", "debug-stop", () => handlers?.stop()));
  root.appendChild(toolbar);

  // P1（UX 审查）：starting 阶段（debugpy 加载/握手）原先只有灰按钮无任何说明——
  // 加一行带 spinner 的状态提示，显隐由 renderToolbar 按 phase 同步
  const startingHint = document.createElement("div");
  startingHint.id = "debug-starting-hint";
  startingHint.className = "debug-starting-hint hidden";
  startingHint.appendChild(spinIcon());
  const startingText = document.createElement("span");
  startingText.id = "debug-starting-text";
  startingText.textContent = t("debug.status.starting");
  startingHint.appendChild(startingText);
  root.appendChild(startingHint);

  // 调用栈
  const stackHeader = document.createElement("div");
  stackHeader.id = "debug-stack-header";
  stackHeader.className = "debug-section-header";
  stackHeader.textContent = t("debug.section.callStack");
  const stack = document.createElement("div");
  stack.id = "debug-stack";
  root.appendChild(stackHeader);
  root.appendChild(stack);

  // B-1：Watches 监视表达式（变量面板上方；面板 DOM 由 debugWatches 自建）
  const watchesHost = document.createElement("div");
  watchesHost.id = "debug-watches";
  root.appendChild(watchesHost);
  initWatchesPanel(watchesHost, () => activeFrameId);

  // 变量（P2-11：树形展开——容器走 tree 语义，行 treeitem / 子级 group）
  const varsHeader = document.createElement("div");
  varsHeader.id = "debug-vars-header";
  varsHeader.className = "debug-section-header";
  varsHeader.textContent = t("debug.section.variables");
  const vars = document.createElement("div");
  vars.id = "debug-vars";
  vars.setAttribute("role", "tree");
  vars.setAttribute("aria-label", t("debug.section.variables"));
  root.appendChild(varsHeader);
  root.appendChild(vars);

  // 断点列表
  const bpHeader = document.createElement("div");
  bpHeader.id = "debug-breakpoints-header";
  bpHeader.className = "debug-section-header";
  bpHeader.textContent = t("debug.section.breakpoints");
  const bps = document.createElement("div");
  bps.id = "debug-breakpoints";
  root.appendChild(bpHeader);
  root.appendChild(bps);

  onLocaleChange(refreshDebugViewI18n);
  renderDebugView();
}

/** 渲染入口：按当前 phase 更新工具栏可用态 + 三个面板 */
export function renderDebugView(): void {
  renderToolbar();
  renderStack();
  renderVars();
  renderBreakpoints();
}

/** 语言切换刷新：只重绘可安全重建的面板，变量树保留已有值、展开状态和节点身份。 */
function refreshDebugViewI18n(): void {
  document.getElementById("debug-starting-text")!.textContent = t("debug.status.starting");
  document.getElementById("debug-stack-header")!.textContent = t("debug.section.callStack");
  document.getElementById("debug-vars-header")!.textContent = t("debug.section.variables");
  document.getElementById("debug-breakpoints-header")!.textContent = t("debug.section.breakpoints");
  document.getElementById("debug-vars")?.setAttribute("aria-label", t("debug.section.variables"));
  renderToolbar();
  renderStack();
  renderBreakpoints();
  if (dap.currentPhase() !== "stopped") renderVars();
  else refreshVariableTreeI18n();
}

function refreshVariableTreeI18n(): void {
  const vars = $soft("debug-vars");
  if (!vars) return;
  const empty = vars.querySelector<HTMLElement>(".empty-state");
  if (empty) {
    empty.querySelector<HTMLElement>(".empty-title")!.textContent = t("debug.variables.noLocals");
    empty.querySelector<HTMLElement>(".empty-description")!.textContent = t("debug.variables.noLocalsHint");
  }
  for (const row of Array.from(vars.querySelectorAll<HTMLElement>("[data-debug-var-row]"))) {
    const value = row.querySelector<HTMLElement>(".debug-var-value");
    if (!value) continue;
    const name = row.dataset.varName ?? "";
    const current = row.dataset.varValue ?? value.title;
    value.dataset.tip = t("debug.variable.editTip");
    value.setAttribute("aria-label", t("debug.variable.editAria", { name, value: current }));
  }
  for (const el of Array.from(vars.querySelectorAll<HTMLElement>("[data-debug-var-empty]"))) {
    const kind = el.dataset.debugVarEmpty;
    if (kind === "depth") el.textContent = t("debug.variable.depthLimit", { depth: MAX_VAR_DEPTH });
    else if (kind === "empty") el.textContent = t("debug.variable.empty");
    else if (kind === "childrenFailed") el.textContent = t("debug.variable.childrenFailed");
  }
}

function renderToolbar(): void {
  const phase = dap.currentPhase();
  const canControl = phase === "stopped" || phase === "running";
  const stopped = phase === "stopped";
  const btn = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  // UI-09：禁用态改用 .is-disabled + aria-disabled（不用 disabled 属性），理由见 toolbarButton；
  // 同时每次渲染刷新提示，使快捷键副文本跟随用户在设置里的改键。
  const set = (id: string, enabled: boolean) => {
    const el = btn(id);
    if (!el) return;
    el.classList.toggle("is-disabled", !enabled);
    el.setAttribute("aria-disabled", String(!enabled));
    applyToolbarTip(el, id);
  };
  // 继续/步进只在 stopped 态可用；暂停只在 running 态可用；停止在 starting/running/stopped 可用
  set("debug-continue", stopped);
  set("debug-step-over", stopped);
  set("debug-step-into", stopped);
  set("debug-step-out", stopped);
  set("debug-pause", phase === "running");
  set("debug-stop", canControl || phase === "starting");
  // P1（UX 审查）：starting 阶段显示「启动中…」状态提示（元素在 initDebugView 构建）
  document.getElementById("debug-starting-hint")?.classList.toggle("hidden", phase !== "starting");
}

/** 渲染期元素获取：缺元素静默跳过（$ 会抛错，DOM 未建好时 phase 回调可能先于 initDebugView） */
function $soft(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function renderStack(): void {
  const el = $soft("debug-stack");
  if (!el) return;
  el.textContent = "";
  const phase = dap.currentPhase();
  if (phase !== "stopped" || activeFrames.length === 0) {
    // UI-12：改用统一的 emptyState()（图标 + 标题 + 说明），与文件树/大纲/搜索面板同一套视觉语言。
    // compact=true：侧栏是窄区域（默认 280px），用紧凑档避免大块留白。
    // 顺带修掉两个文案缺陷：① phase==="stopped" 但无栈帧时，原先塞的是 textContent="" 的空 div，
    // 用户看到彻底空白、无从判断是异常还是正常；② 「未在调试」原先不给任何下一步指引。
    if (phase === "stopped") {
      el.appendChild(emptyState("debug-alt", t("debug.stack.noInfo"), t("debug.stack.noFramesHint"), true));
    } else if (phase === "idle") {
      // 快捷键读键位系统而非硬编码 F5（同 UI-09 对工具栏提示的处理），改键后文案不会失真
      const key = bindingLabel("debug");
      el.appendChild(emptyState(
        "debug-alt",
        t("debug.stack.notDebugging"),
        key ? t("debug.stack.notDebuggingHint", { shortcut: key }) : t("debug.stack.notDebuggingNoShortcut"),
        true,
      ));
    } else {
      el.appendChild(emptyState("debug-alt", t("debug.stack.running"), t("debug.stack.runningHint"), true));
    }
    return;
  }
  for (const frame of activeFrames) {
    const row = document.createElement("div");
    row.className = `debug-stack-frame${frame.id === activeFrameId ? " active" : ""}`;
    const name = document.createElement("span");
    name.textContent = frame.name;
    row.appendChild(name);
    const loc = document.createElement("span");
    loc.className = "debug-frame-loc";
    loc.textContent = frame.source?.name
      ? `${frame.source.name}:${frame.line}`
      : `:${frame.line}`;
    row.appendChild(loc);
    // UI-16：可点击行补 button 语义 + 键盘激活（此前鼠标独占；行内容是可访问名称，无需 aria-label）
    const jump = (): void => {
      // 点击帧 → 跳转源码（§1.1：点击帧跳转源码）
      const path = frame.source?.path;
      if (path) {
        activeFrameId = frame.id;
        dap.setActiveFrameId(frame.id); // B-8：帧镜像同步（hover 求值等只读消费方取用）
        handlers?.openFile(path, frame.line);
        renderStack();
        void refreshVariables();
      }
    };
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.addEventListener("click", jump);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        jump();
      }
    });
    el.appendChild(row);
  }
}

function renderVars(): void {
  const el = $soft("debug-vars");
  if (!el) return;
  el.textContent = "";
  const phase = dap.currentPhase();
  if (phase !== "stopped") {
    // UI-12：原先塞的是 textContent="" 的空 div（纯占位，用户看到彻底空白，容易误以为面板坏了）。
    // 改为明确说明变量的可见条件，与调用栈面板的空态语言保持一致。
    el.appendChild(emptyState(
      "debug-alt",
      phase === "idle" ? t("debug.stack.notDebugging") : t("debug.stack.running"),
      t("debug.variables.notStopped"),
      true,
    ));
    return;
  }
}

/** 断点摘要文本（侧栏窄区显示，过长截短）：条件 / 命中次数 / 日志消息，按此优先级取一条 */
function breakpointDetail(bp: DapSourceBreakpoint): string {
  const raw = bp.logMessage
    ? t("debug.breakpoint.logDetail", { message: bp.logMessage })
    : bp.condition
      ? t("debug.breakpoint.conditionDetail", { condition: bp.condition })
      : bp.hitCondition
        ? t("debug.breakpoint.hitDetail", { condition: bp.hitCondition })
        : "";
  return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
}

function renderBreakpoints(): void {
  const el = $soft("debug-breakpoints");
  if (!el) return;
  el.textContent = "";

  // B-2：异常断点开关（不依赖普通断点是否存在，常驻断点面板顶部）
  const excHeader = document.createElement("div");
  excHeader.className = "debug-section-header";
  excHeader.textContent = t("debug.breakpoint.exceptionHeader");
  el.appendChild(excHeader);
  const filters = dap.getExceptionFilters();
  for (const opt of [
    { id: "uncaught", label: t("debug.breakpoint.uncaught") },
    { id: "raised", label: t("debug.breakpoint.raised") },
  ]) {
    const row = document.createElement("div");
    row.className = "debug-exc-row";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.id = `debug-exc-${opt.id}`;
    chk.checked = filters.includes(opt.id);
    chk.addEventListener("change", () => {
      const next = new Set(dap.getExceptionFilters());
      if (chk.checked) next.add(opt.id);
      else next.delete(opt.id);
      void dap.setExceptionFilters([...next]).then(
        () => undefined,
        (e) => {
          // G-3：下发失败回滚勾选态并提示——否则 UI 已勾选、debugger 实际未生效
          chk.checked = !chk.checked;
          toastFail(t("debug.breakpoint.settingFailed"), e);
        },
      );
    });
    const lb = document.createElement("label");
    lb.htmlFor = chk.id;
    lb.textContent = opt.label;
    row.append(chk, lb);
    el.appendChild(row);
  }

  const bpHeader = document.createElement("div");
  bpHeader.className = "debug-section-header";
  bpHeader.textContent = t("debug.section.breakpoints");
  el.appendChild(bpHeader);

  const files = breakpointFiles();
  const entries: [string, DapSourceBreakpoint[]][] = files.map((p) => [p, getBreakpoints(p)]);
  if (entries.length === 0) {
    // UI-12：改用统一 emptyState()。原文案把「标题 + 操作指引」挤在一行的括号里，
    // 拆成标题与说明两层后更易扫读；图标用 debug-breakpoint，与编辑器 gutter 里的断点图形呼应。
    el.appendChild(emptyState("debug-breakpoint", t("debug.breakpoint.none"), t("debug.breakpoint.noneHint"), true));
    return;
  }
  for (const [path, bps] of entries) {
    for (const bp of bps) {
      const line = bp.line;
      const kind = breakpointKind(bp);
      const enabled = isBreakpointEnabled(bp);
      const row = document.createElement("div");
      row.className = enabled ? "debug-bp-row" : "debug-bp-row debug-bp-disabled";
      // B-6：启用/禁用勾选（禁用 = 保留断点但不下发 debugger，gutter 显示灰点）
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = enabled;
      chk.title = enabled ? t("debug.breakpoint.enabled") : t("debug.breakpoint.disabled");
      chk.setAttribute("aria-label", t("debug.breakpoint.enableAria", { file: basename(path), line: line }));
      chk.addEventListener("change", () => {
        setBreakpointEnabled(path, line, chk.checked);
        handlers?.refreshGutter();
      });
      row.appendChild(chk);
      const icon = document.createElement("span");
      // P0：条件断点 / Logpoint 用不同图形，与编辑器 gutter 的装饰同源
      icon.className = `debug-bp-dot${kind === "plain" ? "" : ` debug-bp-dot-${kind}`}`;
      row.appendChild(icon);
      const label = document.createElement("span");
      label.className = "debug-bp-label";
      label.textContent = `${basename(path)}:${line}`;
      // UI-16：可点击 span 补 button 语义 + 键盘激活（行文本 t("debug.breakpoint.fileLineHint") 即可访问名称）
      label.setAttribute("role", "button");
      label.tabIndex = 0;
      label.addEventListener("click", () => handlers?.openFile(path, line));
      label.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          handlers?.openFile(path, line);
        }
      });
      row.appendChild(label);
      // 条件 / 命中次数 / 日志消息：侧栏窄，摘要截短后挂 title 与 tooltip 全文
      const detail = breakpointDetail(bp);
      if (detail) {
        const d = document.createElement("span");
        d.className = "debug-bp-detail";
        d.textContent = detail;
        d.title = detail;
        d.dataset.tip = detail;
        row.appendChild(d);
      }
      const del = document.createElement("span");
      del.className = "debug-bp-del";
      // UI-09：同 .term-tab-close，span 结构下只统一视觉轨，role/键盘可达性归 UI-16
      // UI-16：已补齐——role=button + aria-label（icon-only，无文本可作名称）+ tabindex + Enter/Space
      del.dataset.tip = t("debug.breakpoint.delete");
      del.appendChild(codicon("close"));
      del.setAttribute("role", "button");
      del.setAttribute("aria-label", t("debug.breakpoint.deleteAria", { file: basename(path), line: line }));
      del.tabIndex = 0;
      const removeBp = (): void => {
        // 删除单行断点（removeBreakpoint 内部完成同步；其余行的高级属性不受影响）
        removeBreakpoint(path, line);
        handlers?.refreshGutter();
        renderBreakpoints();
      };
      del.addEventListener("click", removeBp);
      del.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          removeBp();
        }
      });
      row.appendChild(del);
      el.appendChild(row);
    }
  }
}

// ---------- DAP 事件 → 状态刷新 ----------

/** 调试会话事件接线（main.ts 启动时调用一次） */
export function wireDebugViewEvents(): void {
  // 断点表变更（gutter 点击 / 本列表删除）→ 重渲染断点列表
  setBreakpointsChangeCallback(() => renderBreakpoints());

  dap.onPhase(() => {
    // 会话结束：清栈/变量态（断点表保留）
    if (dap.currentPhase() === "exited" || dap.currentPhase() === "idle") {
      activeFrames = [];
      activeFrameId = null;
      dap.setActiveFrameId(null); // B-8：会话结束清帧镜像
      activeVars = [];
      activeScopeRef = 0;
      // P2-1（2026-09-29 review）：会话结束时 Run to Cursor 的临时断点若未被命中
      //（用户 Shift+F5 / 脚本自然退出 / 崩溃），此前只丢引用不删表项——该断点残留
      // 在断点表 + breakpoints.json（跨会话持久化 + pushAllBreakpoints 重放），
      // 用户从未主动设置过它。改为真正撤掉（clearTempBreakpoint 幂等：无临时断点时 no-op）。
      clearTempBreakpoint();
      clearWatchesValues(); // B-1：清监视值（表达式保留）
      expandedRefs.clear();
      clearInlineValues();
    }
    renderDebugView();
  });

  dap.onEvent("stopped", (body) => {
    // 断点命中：刷新调用栈 + 变量 + 当前行高亮（§1.1 最小闭环）
    void handleStopped(body);
  });

  dap.onEvent("continued", () => {
    // 继续执行：清当前行高亮（变量面板下次 stopped 再刷）
    clearCurrentLine();
    // P2：行内变量值是「暂停态快照」，跑起来后即为过期信息，必须清掉
    clearInlineValues();
  });

  dap.onEvent("terminated", () => {
    // debugpy 报告会话终止（脚本自然跑完）；后端退出监视会随后 emit debug-exited。
    // 清掉执行行高亮与行内变量快照（否则程序跑完后黄色当前行会残留，体验割裂）。
    clearCurrentLine();
    clearInlineValues();
  });

  // 注：`output` 事件**不在此处**订阅——它归调试控制台（debugConsole.ts）所有。
  // P0 的 Logpoint 正是靠 output 事件把求值结果送出来，此前这里注册了一个空回调，
  // 会静默吃掉 Logpoint 的全部输出（onEvent 是单回调表，后注册者覆盖先注册者）。
}

async function handleStopped(body: { threadId?: number; reason?: string }): Promise<void> {
  activeThreadId = body.threadId ?? 1;
  // P2-11：新的暂停点 variablesReference 全部失效——展开状态与在途请求一并作废
  expandedRefs.clear();
  varToken++;
  // P2：Run to Cursor 的临时断点用完即撤（必须在刷新变量之前，免得残留到下一次暂停）
  clearTempBreakpoint();
  try {
    activeFrames = await dap.dapStackTrace(activeThreadId);
    activeFrameId = activeFrames[0]?.id ?? null;
    dap.setActiveFrameId(activeFrameId); // B-8：帧镜像同步
    // 当前行高亮：栈顶帧
    const top = activeFrames[0];
    if (top?.source?.path) {
      highlightCurrentLine(top.source.path, top.line);
    }
    renderDebugView();
    await refreshVariables();
  } catch (e) {
    console.warn("[debugView] stopped 处理失败:", e);
  }
}

async function refreshVariables(): Promise<void> {
  const el = $soft("debug-vars");
  if (!el) return;
  const token = ++varToken; // CR-20：异步刷新令牌（scopes/variables 都是 await，旧响应不得覆盖新面板）
  el.textContent = "";
  activeVars = [];
  activeScopeRef = 0;
  clearInlineValues();
  if (activeFrameId === null) {
    expandedRefs.clear();
    return;
  }
  try {
    // §6.5：栈顶 frameId → scopes → locals scope → variables
    const scopes = await dap.dapScopes(activeFrameId);
    if (token !== varToken) return;
    const locals = scopes.find((s) => s.presentationHint === "locals" || s.name.toLowerCase() === "locals");
    if (!locals) return;
    activeScopeRef = locals.variablesReference;
    activeVars = await dap.dapVariables(activeScopeRef);
    if (token !== varToken) return;
    // 空局部帧（如停在函数首行、局部变量尚未赋值）也要给空态提示，而非留白——
    // 真机实测（CDP 验收 R-REAL）：pydevd 此时返回 {"variables":[]}，此前面板空白无任何解释。
    if (activeVars.length === 0) {
      el.appendChild(emptyState("debug-alt", t("debug.variables.noLocals"), t("debug.variables.noLocalsHint"), true));
      return;
    }
    // P2-11（UX 审查）：树形渲染——variablesReference>0 的行可展开，懒加载子级（递归）
    for (const v of activeVars) renderVarRow(el, v, activeScopeRef, 0, token);
    // P2：行内变量值——复用本次 variables 请求的结果，不再额外发 DAP 请求
    const path = activeFrames[0]?.source?.path;
    if (path) updateInlineValues(path, activeVars);
    // B-1：Watches 随帧刷新（求值用 "watch" context，无副作用）
    void refreshWatches(activeFrameId);
  } catch (e) {
    console.warn("[debugView] 变量刷新失败:", e);
  }
}

/** 行缩进（照 fileTree 的 depth → paddingLeft 范式） */
function varPad(depth: number): string {
  return `${8 + depth * 14}px`;
}

/** twisty / aria-expanded 的单一写入点（fileTree::setTwisty 同款纪律：视觉与读屏同源切换） */
function setRowExpanded(row: HTMLElement, on: boolean): void {
  row.setAttribute("aria-expanded", String(on));
  const twisty = row.querySelector<HTMLElement>(".twisty");
  twisty?.classList.toggle("codicon-chevron-right", !on);
  twisty?.classList.toggle("codicon-chevron-down", on);
}

/**
 * 渲染一行变量（P2-11 树形展开）。
 * - variablesReference > 0（dict/list/对象等）：twisty 可展开，子级懒加载；
 * - 值点击仍是 Set Value（嵌套项改写需要父容器 ref，见 setValue）；
 * - 展开状态记在 expandedRefs（单次 stopped 内有效），setValue 后的刷新据此重建子树。
 */
function renderVarRow(container: HTMLElement, v: DapVariable, parentRef: number, depth: number, token: number): void {
  const expandable = v.variablesReference > 0;
  const row = document.createElement("div");
  row.className = "debug-var-row";
  row.dataset.debugVarRow = "true";
  row.dataset.varName = v.name;
  row.dataset.varValue = v.value;
  row.style.paddingLeft = varPad(depth);
  if (expandable) {
    row.setAttribute("role", "treeitem");
    row.tabIndex = 0;
  }

  // twisty / 占位：两列对齐（无子级行也缩进一格）
  const twisty = document.createElement("i");
  twisty.className = expandable ? "twisty codicon codicon-chevron-right" : "twisty tw-placeholder";
  twisty.setAttribute("aria-hidden", "true");
  row.appendChild(twisty);

  const name = document.createElement("span");
  name.className = "debug-var-name";
  name.textContent = v.name;
  row.appendChild(name);

  const value = document.createElement("span");
  value.className = "debug-var-value";
  // B-7：值截断（巨型字符串/长列表会让侧栏表格与 tooltip 卡顿；完整值挂 title）
  const display = v.value.length > MAX_VAR_VALUE_LEN ? `${v.value.slice(0, MAX_VAR_VALUE_LEN - 1)}…` : v.value;
  value.textContent = display;
  value.title = v.value;
  // P2：Set Value——点击值即可改写（PyCharm 同款交互）。
  // 嵌套项的容器是父变量自身的 variablesReference（debugpy 的 setVariable 需要「容器 + 名字」）。
  value.dataset.tip = t("debug.variable.editTip");
  value.setAttribute("role", "button");
  value.setAttribute("aria-label", t("debug.variable.editAria", { name: v.name, value: v.value }));
  value.tabIndex = 0;
  const edit = (ev: Event): void => {
    ev.stopPropagation(); // 值点击 = 改值，不触发行的展开/折叠
    void setValue(v.name, v.value, parentRef);
  };
  value.addEventListener("click", edit);
  value.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      edit(ev);
    }
  });
  row.appendChild(value);

  if (expandable) {
    const open = expandedRefs.has(v.variablesReference);
    setRowExpanded(row, open);
    const toggle = (): void => void toggleVarChildren(row, v, depth, token);
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle();
      }
    });
  }
  container.appendChild(row);

  // 刷新路径：已展开的 ref 直接重建子容器（展开状态在 setValue 刷新后不丢）
  if (expandable && expandedRefs.has(v.variablesReference)) {
    setRowExpanded(row, true);
    const group = document.createElement("div");
    group.className = "debug-var-children";
    group.setAttribute("role", "group");
    container.appendChild(group);
    void loadChildren(group, v.variablesReference, depth, token);
  }
}

/** 展开/折叠一个可展开变量：子容器紧跟行后（折叠即移除），子级懒加载 */
async function toggleVarChildren(row: HTMLElement, v: DapVariable, depth: number, token: number): Promise<void> {
  const ref = v.variablesReference;
  if (expandedRefs.has(ref)) {
    expandedRefs.delete(ref);
    row.nextElementSibling?.remove(); // 子容器紧跟行后（renderVarRow 的渲染顺序保证）
    setRowExpanded(row, false);
    return;
  }
  expandedRefs.add(ref);
  setRowExpanded(row, true);
  const group = document.createElement("div");
  group.className = "debug-var-children";
  group.setAttribute("role", "group");
  row.insertAdjacentElement("afterend", group);
  await loadChildren(group, ref, depth, token);
}

/** 测试专用：把一行变量渲染进指定容器（树形展开回归测试用；生产路径走 refreshVariables，
 *  同 runWidget::setRunWidgetStateForTest 先例）。token 取当前 varToken（调用方无法触达私有令牌）。 */
export function renderVarRowForTest(container: HTMLElement, v: DapVariable, parentRef: number, depth: number): void {
  renderVarRow(container, v, parentRef, depth, varToken);
}

/** 测试专用：清空展开状态与令牌（测试间隔离；生产路径由 handleStopped/reset 负责） */
export function resetVarTreeForTest(): void {
  expandedRefs.clear();
  varToken++;
}

/** 拉取并渲染某容器的子变量（递归；令牌失效或已非暂停态则丢弃响应） */
async function loadChildren(group: HTMLElement, ref: number, depth: number, token: number): Promise<void> {
  // B-7：展开深度上限——巨型嵌套对象（递归结构/大 DataFrame）的懒加载仍可能被用户
  // 一路点开撑爆侧栏；到上限后停在提示行，不再发 variables 请求（G-1：任何展开必须有界）。
  if (depth >= MAX_VAR_DEPTH) {
    const cap = document.createElement("div");
    cap.className = "debug-var-row debug-var-empty";
    cap.dataset.debugVarEmpty = "depth";
    cap.style.paddingLeft = varPad(depth + 1);
    cap.textContent = t("debug.variable.depthLimit", { depth: MAX_VAR_DEPTH });
    group.appendChild(cap);
    return;
  }
  try {
    const children = await dap.dapVariables(ref);
    if (token !== varToken || dap.currentPhase() !== "stopped") return;
    group.textContent = "";
    if (children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "debug-var-row debug-var-empty";
      empty.dataset.debugVarEmpty = "empty";
      empty.style.paddingLeft = varPad(depth + 1);
      empty.textContent = t("debug.variable.empty");
      group.appendChild(empty);
      return;
    }
    for (const c of children) renderVarRow(group, c, ref, depth + 1, token);
  } catch (e) {
    // UX P0-1 纪律：失败要可见——空展开区会让用户以为「没有子级」
    console.warn("[debugView] 子变量加载失败:", e);
    group.textContent = "";
    const row = document.createElement("div");
    row.className = "debug-var-row debug-var-empty";
    row.dataset.debugVarEmpty = "childrenFailed";
    row.style.paddingLeft = varPad(depth + 1);
    row.textContent = t("debug.variable.childrenFailed");
    group.appendChild(row);
  }
}

/** P2：Set Value——在断点处改写变量值（DAP `setVariable`；parentRef = 变量所在容器） */
async function setValue(name: string, current: string, parentRef: number): Promise<void> {
  if (dap.currentPhase() !== "stopped" || activeScopeRef === 0 || parentRef === 0) return;
  const next = await openPrompt({
    title: t("debug.variable.editTitle", { name: name }),
    label: t("debug.variable.editLabel"),
    value: current,
    okLabel: t("debug.variable.set"),
  });
  if (next === null || next === current) return; // 取消 / 未改动
  try {
    await dap.dapSetVariable(parentRef, name, next);
    await refreshVariables(); // expandedRefs 保留：已展开的子树按新值重建
  } catch (e) {
    console.warn("[debugView] setVariable 失败:", e);
    toastFail(t("debug.variable.updateFailed"), e);
  }
}

/**
 * P2：Run to Cursor（PyCharm Alt+F9）——在光标行设一个**临时断点**然后继续。
 * 命中断点后由 `handleStopped` 调用 `clearTempBreakpoint()` 撤掉它。
 */
export async function runToCursor(path: string, line: number): Promise<void> {
  if (dap.currentPhase() !== "stopped") return;
  // 该行已有断点（普通/条件/logpoint 皆可）→ 直接继续，不动用户的断点
  const existing = getBreakpointSpec(path, line);
  if (existing) {
    await dap.dapContinue(activeThreadId);
    return;
  }
  tempBreakpoint = { path, line, hadBefore: false };
  updateBreakpoint(path, line, {});
  await syncBreakpointsToDebugger(path);
  await dap.dapContinue(activeThreadId);
}

/** 撤掉 Run to Cursor 的临时断点（每次 stopped 调用；非临时断点一律不动） */
function clearTempBreakpoint(): void {
  const t = tempBreakpoint;
  tempBreakpoint = null;
  if (!t || t.hadBefore) return;
  removeBreakpoint(t.path, t.line);
  void syncBreakpointsToDebugger(t.path);
}

// ---------- 步进控制 ----------

async function onContinue(): Promise<void> {
  try {
    await dap.dapContinue(activeThreadId);
  } catch (e) {
    console.warn("[debugView] continue 失败:", e);
    toastFail(t("debug.action.continue"), e);
  }
}

async function onPause(): Promise<void> {
  try {
    await dap.request("pause", { threadId: activeThreadId });
  } catch (e) {
    console.warn("[debugView] pause 失败:", e);
    toastFail(t("debug.toolbar.pause"), e);
  }
}

async function onStep(kind: "next" | "stepIn" | "stepOut"): Promise<void> {
  try {
    if (kind === "next") await dap.dapNext(activeThreadId);
    else if (kind === "stepIn") await dap.dapStepIn(activeThreadId);
    else await dap.dapStepOut(activeThreadId);
  } catch (e) {
    console.warn(`[debugView] ${kind} 失败:`, e);
    toastFail(kind === "next" ? t("debug.toolbar.stepOver") : kind === "stepIn" ? t("debug.toolbar.stepInto") : t("debug.action.stepOut"), e);
  }
}
