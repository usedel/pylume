// 运行组 UI 域（v3.4 §8 / §17-2）：菜单栏全局四控件
// [▶ 运行脚本] [▶ 运行项目] [⏹ 停止] [⚙ 运行配置…]——状态 × 界面矩阵见 §7.3。
// 与 main.ts 解耦：main.ts 拥有运行动作与运行态真值，本模块只负责「渲染 + 派发」——
// handlers 注入（同 terminal.ts::setTerminalLinkHandler 先例），避免循环导入。
// 所有状态变化点调用 renderRunWidget 重绘。本模块只更新按钮属性/类名，不重建按钮 DOM（T10）。

import { lazyEl } from "./state";
import { onLocaleChange, t } from "./i18n"; // 第五批 i18n：运行组控件 tip 走语言包

export interface RunWidgetState {
  /** 是否打开了工作区（§18 裁决 7：无工作区一律禁用，含脚本运行） */
  hasWs: boolean;
  /** 「运行脚本」可用（工作区 + 活动 .py/.pyw；§7.3 idle 行） */
  canRunScript: boolean;
  /** 「运行脚本」置灰原因（空 = 可用） */
  scriptDisabledReason: string;
  /** 「运行项目」可用（只要求工作区；入口探测不到时提示配置，不置灰） */
  canRunProject: boolean;
  /** 「运行项目」置灰原因（空 = 可用） */
  projectDisabledReason: string;
  /** 脚本运行进行中（running 或 preparing；驱动「运行脚本」置灰） */
  scriptBusy: boolean;
  /** 项目运行进行中（running 或 preparing；供菜单禁用判定） */
  projectBusy: boolean;
  /** 脚本准备期（spinner 专属——与 running 区分，§7.3） */
  scriptPreparing: boolean;
  /** 项目准备期（spinner 专属——running 时「运行项目」可点弹二选一，§7.3） */
  projectPreparing: boolean;
  /** 调试进行中（⏹ 路由 debug_stop；脚本运行拒绝，§13.2） */
  debugging: boolean;
  runScriptShortcut: string;
  runProjectShortcut: string;
  stopShortcut: string;
  /** ⏹ 将停止的目标（最近启动且在跑的实例标签；null = 没有在跑的） */
  stopTarget: string | null;
  /** 有工作区（运行配置入口可用性；面板是工作区级的，不依赖活动文件） */
  canOpenConfig: boolean;
}

export interface RunWidgetHandlers {
  runScript: () => void;
  runProject: () => void;
  stop: () => void;
  openRunConfig: () => void;
}

export interface RunButtonState {
  disabled: boolean;
  tip: string;
  tipKey?: string;
  /** 准备中——▶ 图标切为旋转 loader（data-tip 已解释原因） */
  busy?: boolean;
}

export interface RunWidgetComputed {
  runScript: RunButtonState;
  runProject: RunButtonState;
  stop: RunButtonState;
  config: RunButtonState;
}

// CR-26：顶层 DOM 快照改惰性（computeRunWidget 是纯函数，测试环境无 DOM 也要可 import）
const btnRunScript = lazyEl<HTMLButtonElement>("btn-run-script");
const btnRunProject = lazyEl<HTMLButtonElement>("btn-run-project");
const btnStop = lazyEl<HTMLButtonElement>("btn-stop");
const btnConfig = lazyEl<HTMLButtonElement>("btn-run-config");

let handlers: RunWidgetHandlers | null = null;
/** 设置保存后改键位不会走 renderTabs，由 main 注册一个「重新组装状态并重绘」的回调补那条路径 */
let repaintFn: (() => void) | null = null;

export function setRunWidgetHandlers(h: RunWidgetHandlers): void {
  handlers = h;
}

export function setRunWidgetRepaint(fn: () => void): void {
  repaintFn = fn;
}

/** 触发重绘（由 main 注册的回调组装最新状态；当前值有则可直接重绘） */
export function repaintRunWidget(): void {
  repaintFn?.();
}

/** 当前注入的 handlers（gutter 右键 / 标签右键共用运行组动作，保证各入口一致） */
export function runWidgetHandlers(): RunWidgetHandlers | null {
  return handlers;
}

/** 纯函数：把运行态映射为四控件的亮/灰 + tooltip 文案（§7.3 矩阵；可单测，不碰 DOM）。 */
export function computeRunWidget(s: RunWidgetState): RunWidgetComputed {
  // ⏹：调试中路由 debug_stop（D4）；否则停最近启动且在跑的实例（§10）
  const stopTip = s.debugging
    ? t("run.widget.stopDebug")
    : s.stopTarget
      ? t("run.widget.stopRun", { target: s.stopTarget })
      : t("run.widget.notRunning");
  const stopState: RunButtonState = s.debugging || !!s.stopTarget
    ? { disabled: false, tip: stopTip, tipKey: s.debugging ? undefined : s.stopShortcut }
    : { disabled: true, tip: stopTip };

  // ⚙ 运行配置…：工作区级入口
  const configState: RunButtonState = s.canOpenConfig
    ? { disabled: false, tip: t("run.widget.cfgTip") }
    : { disabled: true, tip: t("run.widget.needWorkspace") };

  // ▶ 运行脚本（§7.3）：preparing spinner → 脚本运行置灰 → 调试拒绝 → 可用「运行 <文件名>」。
  // 置灰判定 = !canRunScript（文件前提不满足）**或 scriptDisabledReason 非空**（运行中 /
  // 调试中——runFlow 已把 busy 推导进 reason；Playwright 实测修复：拆 preparing 时
  // 曾把 busy 置灰分支拆丢，导致脚本 running 时 ▶ 仍可点）
  let runScriptState: RunButtonState;
  if (s.scriptPreparing) {
    runScriptState = { disabled: true, tip: t("run.widget.preparingScript"), busy: true };
  } else if (!s.canRunScript || s.scriptDisabledReason) {
    runScriptState = { disabled: true, tip: s.scriptDisabledReason };
  } else {
    runScriptState = { disabled: false, tip: "", tipKey: s.runScriptShortcut };
  }

  // ▶ 运行项目（§7.3）：preparing spinner；running → **可点**（触发二选一，§6.4）；
  // 无工作区置灰；入口探测不到不置灰（点击后提示配置）
  let runProjectState: RunButtonState;
  if (s.projectPreparing) {
    runProjectState = { disabled: true, tip: t("run.widget.preparingProject"), busy: true };
  } else if (!s.canRunProject) {
    runProjectState = { disabled: true, tip: s.projectDisabledReason };
  } else {
    runProjectState = { disabled: false, tip: s.projectBusy ? t("run.widget.projectRunningTip") : "", tipKey: s.runProjectShortcut };
  }

  return { runScript: runScriptState, runProject: runProjectState, stop: stopState, config: configState };
}

/** 按状态重绘四控件的亮/灰、tooltip、tip-key。所有状态变化点都要调它。 */
export function renderRunWidget(s: RunWidgetState): void {
  const c = computeRunWidget(s);
  applyButton(btnRunScript, c.runScript);
  applyButton(btnRunProject, c.runProject);
  applyButton(btnStop, c.stop);
  applyButton(btnConfig, c.config);
}

/** UX P0-3：禁用态用 .is-disabled 类 + aria-disabled（debugView 工具栏同款模式），
 *  不用 disabled 属性——Chromium 不向禁用的表单控件派发鼠标事件，data-tip 会静默失效，
 *  而「为什么不能运行」的原因文案恰是灰按钮最需要展示的信息；附带让按钮留在 tab 序列，
 *  键盘/读屏用户也能发现控件并听到「已禁用」。点击守卫在 wireRunWidget 的回调里。 */
function applyButton(btn: HTMLButtonElement, b: RunButtonState): void {
  btn.classList.toggle("is-disabled", b.disabled);
  btn.setAttribute("aria-disabled", String(b.disabled));
  btn.dataset.tip = b.tip;
  if (b.tipKey) btn.dataset.tipKey = b.tipKey;
  else delete btn.dataset.tipKey;
  // 准备中把 ▶ 切为旋转 loader（codicon-modifier-spin 已随「减少动画」自动归零）。
  // 恢复时还原**本命图标**（首个 codicon-* 类，四控件各异：run / run-all / debug-stop / gear）——
  // 此前硬编码加 codicon-run，会让 ▶项目 恢复后叠加第二个图标类（同特异性 content 互相覆盖）。
  const icon = btn.querySelector<HTMLElement>("i.codicon");
  if (icon) {
    if (b.busy) {
      const native = nativeIconOf(icon);
      if (native) icon.dataset.nativeIcon = native;
      icon.classList.remove("codicon-run", "codicon-run-all");
      icon.classList.add("codicon-loading", "codicon-modifier-spin");
    } else if (icon.classList.contains("codicon-loading")) {
      icon.classList.remove("codicon-loading", "codicon-modifier-spin");
      const native = icon.dataset.nativeIcon;
      if (native) icon.classList.add(native);
      delete icon.dataset.nativeIcon;
    }
  }
}

/** 取图标的本命 codicon 类（首个 codicon- 开头且非 loading/spin 的类名） */
function nativeIconOf(icon: HTMLElement): string | null {
  for (const c of icon.classList) {
    if (c.startsWith("codicon-") && c !== "codicon-loading" && c !== "codicon-modifier-spin") return c;
  }
  return null;
}

/** 接线四控件（init 调用一次）。UX P0-3：控件不再用 disabled 属性（见 applyButton），
 *  故点击守卫移入回调——.is-disabled 时的点击一律忽略。 */
export function wireRunWidget(): void {
  // 语言切换时重绘四控件（tip/aria 文案在 computeRunWidget 里经 t() 现算，重算即可换语言）
  onLocaleChange(() => repaintRunWidget());

  btnRunScript.addEventListener("click", () => {
    if (btnRunScript.classList.contains("is-disabled")) return;
    handlers?.runScript();
  });
  btnRunProject.addEventListener("click", () => {
    if (btnRunProject.classList.contains("is-disabled")) return;
    handlers?.runProject();
  });
  btnStop.addEventListener("click", () => {
    if (btnStop.classList.contains("is-disabled")) return;
    handlers?.stop();
  });
  btnConfig.addEventListener("click", () => {
    if (btnConfig.classList.contains("is-disabled")) return;
    handlers?.openRunConfig();
  });
}
