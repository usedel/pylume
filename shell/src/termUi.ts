// 终端功能域（TD-007 迁出 main.ts）：集成终端多会话 UI（Phase 4 / P2-7）+
// 底部面板标签切换（输出 / 终端 / 差异 / Git）。term-data/term-exit 事件分发也在此接线。
//
// v3.4 M3（§17-5）：termUi 按实例化——运行终端的退出回调 / runActive / tab 查找 /
// 停止路由全部按实例 id 绑定（多实例：脚本唯一「运行」+「项目 N」并行）；启动前确保
// tab 存在（无则重建，§7.1 不变式）；preparing 期关闭 tab 的竞态用 canceled 标记 +
// invoke 返回后按 id 幂等补杀兜底（§7.4）。
//
// v3.4 §11（M3-3.8）：运行历史采集挂到 term-data 分发点——按实例 id 归属，剥离 ANSI。

import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { app, $, lazyEl, outputEl } from "./state";
import { basename, codicon, emptyState, parentDirOf, stripAnsi } from "./util"; // UI-12：终端无会话时的空态；stripAnsi（§11 历史采集）
import { IntegratedTerminal } from "./terminal";
import { clearOutput, getOutputLevelCounts, refilterOutputChannel, refilterOutputLevels, setOutputChannelFilter, setOutputLevelFilter, setOutputLevelCountsSink, type OutputChannel, type OutputLogLevel } from "./output";
import { hasGitDetailContent, renderGitDetailEmptyState } from "./git";
import { showMenu } from "./menu";
import { sniffTerminalOutput, handleTracebackLine } from "./depHealth"; // M2 §4.4 嗅探 / M4-3 traceback 一键安装
import { t } from "./i18n"; // 第十三批 i18n：动态文案走语言包

// ---------- 域内状态 ----------

/** 单个终端会话（P2-7 多会话） */
interface TermSessionUI {
  id: string;
  label: string;
  venv: string | null;
  iterm: IntegratedTerminal;
  view: HTMLElement;
  /** S3："run" = 专用「运行终端」（脚本跑完即结束会话）；"shell" = 普通交互 shell */
  kind: "shell" | "run";
  /** 运行终端专属（v3.4 §17-12）：script = 脚本运行 tab；project = 项目运行 tab */
  runKind?: "script" | "project";
  /** 运行终端专属：当前是否有脚本在跑（驱动 tab 上的停止按钮） */
  runActive: boolean;
  /** 运行终端专属：按实例退出回调（runFlow 注册；自然退出 / 主动停止 / 关闭 tab 三路共用） */
  runExit?: (code: number) => void;
  /** 运行终端专属：按实例输出采集回调（运行历史入档，§11） */
  runOnData?: (text: string) => void;
  /** preparing 期关闭 tab：invoke 返回后按 id 幂等补杀（§7.4 竞态兜底） */
  canceled?: boolean;
  /** 该会话的 shell 别名（"auto"/"pwsh"/"powershell"/"cmd"）；run 会话恒为 "auto"（不参与 shell 选择，仅占位） */
  shell: string;
}

/** 终端会话列表 */
const termSessions: TermSessionUI[] = [];
/** 当前激活的终端 id */
let activeTermId: string | null = null;
/** 终端编号自增（生成 label「终端 N」） */
let termSeq = 0;
/** 项目运行实例序号（v3.4 §17-12：id `run-term-project-<N>`，「项目 2」起为并行实例） */
let projectRunSeq = 1;
/** 输出面板的跨域回调（main.ts 注册，避免 termUi 反向依赖 main.ts 造成循环导入） */
export interface OutputPanelHooks {
  /** 切标签后调用：同步 S4 交互输入行的可见性（输入行只在「输出」标签下有意义） */
  onTabChange: () => void;
  /** 清空输出前调用：丢弃未完结行状态，否则转录器会往已被清空的游离元素里写 */
  onClear: () => void;
}
let outputHooks: OutputPanelHooks | null = null;

export function setOutputPanelHooks(h: OutputPanelHooks): void {
  outputHooks = h;
}

/** 底部面板可切换标签（差异视图已迁入编辑区 tab，不再属于底部） */
export type BottomTab = "output" | "terminal" | "git" | "findUsages" | "problems";
/** 底部面板当前激活标签（输出 / 终端 / 差异 / Git） */
let bottomTab: BottomTab = "output";

/** 当前底部激活标签（只读查询：diff 自动刷新等场景判断 diff 是否前台） */
export function activeBottomTab(): BottomTab {
  return bottomTab;
}

// P2-6（2026-09-29 review）：顶层快照改惰性（铁律 1，测试环境可 import）。
// 全部用法为方法调用/属性访问（Proxy 安全）；作为参数传给 DOM/组件 API 的元素
// 不可用 lazyEl（见 dialog.ts 的 insertBefore 踩坑注释）。
const terminalPanelEl = lazyEl("terminal-panel");
const terminalTabsEl = lazyEl("terminal-tabs");
const terminalViewsEl = lazyEl("terminal-views");
const gitDetailPanelEl = lazyEl("git-detail-panel");
const findUsagesPanelEl = lazyEl("find-usages-panel");

// ---------- 底部面板 ----------

/** `log_level_colors` 开关读取（research §11.9）：关闭后级别着色与过滤整体失效 */
const levelColorsEnabled = (): boolean => app.settings.log_level_colors !== false;

/** §11.7：级别 chips 计数徽标（output.ts 每追加一行上浮一次；计数为 0 时不显示徽标） */
function updateLevelChipCounts(): void {
  const counts = getOutputLevelCounts();
  for (const el of $("output-levels").querySelectorAll<HTMLElement>(".out-chip-count")) {
    const key = el.dataset.count as OutputLogLevel | undefined;
    if (!key) continue;
    const n = counts[key] ?? 0;
    el.textContent = n > 0 ? String(n) : "";
    el.classList.toggle("hidden", n === 0);
  }
}
setOutputLevelCountsSink(updateLevelChipCounts);

/** 设置保存后重算级别 chips 显隐（tab 判定复用 bottomTab；新行着色与既有行重刷走 output.applyOutputLevelSetting） */
export function syncOutputLevelChips(): void {
  $("output-levels").classList.toggle("hidden", bottomTab !== "output" || !levelColorsEnabled());
}

/** 切换底部面板标签（输出 / 终端 / Git 详情；差异视图已迁入编辑区 tab） */
export function setBottomTab(tab: BottomTab): void {
  bottomTab = tab;
  // UI-16：role=tab 的 aria-selected 与 .active 类同源切换（单一写入点）
  for (const [id, sel] of [
    ["tab-output", tab === "output"],
    ["tab-terminal", tab === "terminal"],
    ["tab-git-detail", tab === "git"],
    ["tab-find-usages", tab === "findUsages"],
    ["tab-problems", tab === "problems"],
  ] as const) {
    const el = $(id);
    el.classList.toggle("active", sel);
    el.setAttribute("aria-selected", String(sel));
  }
  outputEl.classList.toggle("hidden", tab !== "output");
  terminalPanelEl.classList.toggle("hidden", tab !== "terminal");
  gitDetailPanelEl.classList.toggle("hidden", tab !== "git");
  findUsagesPanelEl.classList.toggle("hidden", tab !== "findUsages");
  $("problems-panel").classList.toggle("hidden", tab !== "problems");
  $("terminal-cmd").classList.toggle("hidden", tab !== "terminal");
  // P2：输出过滤 chips 只在输出 tab 下出现（其他 tab 下无意义）；
  // 级别 chips 还须 `log_level_colors` 开关打开（关掉后着色与过滤整体失效，research §11.9）
  $("output-channels").classList.toggle("hidden", tab !== "output");
  $("output-levels").classList.toggle("hidden", tab !== "output" || !levelColorsEnabled());
  $("bottom").classList.remove("collapsed");
  if (tab === "terminal") void ensureAnyTerminal();
  outputHooks?.onTabChange();
}

// ---------- 终端会话 ----------

/** 新建终端可选的 shell（取值与设置面板 `terminal_shell` 一致） */
const SHELL_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: t("ide.term.shellAuto") },
  { value: "pwsh", label: "PowerShell 7（pwsh）" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: t("ide.term.shellCmd") },
];

/** shell 短名（tab 标题用）；auto 不额外显示（实际 shell 由后端回退决定） */
function shellShortName(shell: string): string {
  return shell && shell !== "auto" ? shell : "";
}

// ---------- shell 可用性探测（后端 list_shells 运行时探测，避免列出机器上没有的 shell） ----------

/** 可用 shell 别名缓存（不含 "auto"；null = 尚未探测） */
let availableShells: string[] | null = null;

/** 拉取后端探测出的可用 shell 别名并缓存复用 */
async function fetchAvailableShells(): Promise<string[]> {
  if (availableShells) return availableShells;
  try {
    availableShells = await invoke<string[]>("list_shells");
  } catch {
    availableShells = [];
  }
  return availableShells;
}

/** 有效默认 shell：全局默认若（缓存已知时）不可用，退化为 "auto" */
function defaultShell(): string {
  const d = app.settings.terminal_shell ?? "auto";
  if (d === "auto" || !availableShells || availableShells.includes(d)) return d;
  return "auto";
}

/** 终端标题（含 shell 与 venv 指示） */
function termTitle(s: TermSessionUI): string {
  const parts: string[] = [s.label];
  const sh = shellShortName(s.shell);
  if (sh) parts.push(sh);
  if (s.venv) parts.push(s.venv);
  return parts.join(" · ");
}

/** 计算终端默认启动目录（P2-4：工作区根 或 活动文件所在目录） */
function defaultTerminalCwd(): string | null {
  if (app.settings.terminal_cwd === "file" && app.activeTab) {
    return parentDirOf(app.activeTab.path);
  }
  return app.workspaceRoot;
}

/** 当前激活的终端会话 */
function activeTermSession(): TermSessionUI | null {
  return termSessions.find((s) => s.id === activeTermId) ?? null;
}

/** 按 id 查找终端会话（termUi 按实例化的基础查找，§17-5） */
function sessionById(id: string): TermSessionUI | null {
  return termSessions.find((s) => s.id === id) ?? null;
}

/** 新建一个终端会话并设为激活；返回该会话。
 * `shell` 为显式别名；缺省回退全局默认 `app.settings.terminal_shell`。 */
async function createTerminal(cwd: string | null, shell?: string): Promise<TermSessionUI | null> {
  const id = `term-${++termSeq}`;
  const view = document.createElement("div");
  view.className = "terminal-view";
  // UI-16：与 .term-tab（role=tab）配对的面板；xterm 自身管理内部焦点与读屏播报
  view.setAttribute("role", "tabpanel");
  view.tabIndex = -1; // tabpanel 惯例：可被程序聚焦（不占 tab 序列），便于从 tab 跳转进来
  terminalViewsEl.appendChild(view);

  const chosenShell = shell ?? defaultShell();

  const iterm = new IntegratedTerminal(id, view);
  iterm.setOnExit(() => {
    // shell 自然退出后刷新 tab（标题环境指示状态变化）
    if (termSessions.some((x) => x.id === id)) renderTerminalTabs();
  });

  const session: TermSessionUI = {
    id,
    label: t("ide.term.label", { n: termSeq }),
    venv: null,
    iterm,
    view,
    kind: "shell",
    runActive: false,
    shell: chosenShell,
  };
  termSessions.push(session);
  activeTermId = id;
  renderTerminalTabs();
  renderTerminalViews();

  session.venv = await iterm.start(cwd, app.workspaceRoot, chosenShell);
  renderTerminalTabs();
  return session;
}

/** 弹出「新建终端 shell 选择」菜单；先探测可用 shell 再渲染，只展示机器上实际存在的项（auto 恒保留）。 */
async function spawnShellMenu(anchor: HTMLElement): Promise<void> {
  const avail = await fetchAvailableShells();
  const options = SHELL_OPTIONS.filter((o) => o.value === "auto" || avail.includes(o.value));
  showMenu(
    options.map((o) => ({
      label: o.label,
      checked: o.value === defaultShell(),
      action: () => void createTerminal(defaultTerminalCwd(), o.value),
    })),
    anchor,
  );
}

/** 确保有一个可用的**交互 shell** 并激活它；返回该会话（工作区未打开时返回 null）。
 * 运行终端（S3）不算交互 shell：它跑完即结束会话，不能作为「命令…」下拉与手敲命令的落点。 */
async function ensureShellTerminal(): Promise<TermSessionUI | null> {
  const shell = termSessions.find((s) => s.kind === "shell");
  if (shell) {
    activateTerminal(shell.id);
    return shell;
  }
  if (!app.workspaceRoot) return null;
  return createTerminal(defaultTerminalCwd());
}

/** 切到「终端」标签时确保有可看的终端。
 * 已有运行终端时**不自动新建 shell**：用户此刻要看的是运行输出，凭空多一个 shell 会话
 * 只会抢激活态、多起一个 PTY 进程；真需要交互 shell 时点「＋」或用「命令…」下拉按需创建。 */
async function ensureAnyTerminal(): Promise<void> {
  const active = activeTermSession();
  if (active && active.kind === "shell") {
    active.iterm.focus();
    return;
  }
  if (termSessions.some((s) => s.kind === "run")) return;
  const shell = await ensureShellTerminal();
  shell?.iterm.focus();
}

/** 切换激活终端 */
function activateTerminal(id: string): void {
  activeTermId = id;
  renderTerminalTabs();
  renderTerminalViews();
  const s = activeTermSession();
  if (s) {
    s.iterm.relayout();
    s.iterm.focus();
  }
}

/** 运行终端被关闭的回调（runFlow 注册：移除对应实例并复位运行态，§7.1 不变式的
 *  runState 半边——「tab 被关闭 ⇒ 实例必须终止并复位」）。 */
let runTabClosedHook: ((id: string) => void) | null = null;

/** 注入运行 tab 关闭回调（runFlow 的 wireRunFlow 注册） */
export function setRunTabClosedHook(fn: (id: string) => void): void {
  runTabClosedHook = fn;
}

/** 关闭指定终端（运行终端 = 停止 + 关闭，§7.1 不变式：先终止进程再移除 tab） */
async function closeTerminal(id: string): Promise<void> {
  const idx = termSessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [s] = termSessions.splice(idx, 1);
  if (s.kind === "run") {
    // preparing 期（run_in_terminal invoke 在途）：kill 可能打到后端尚未登记的 id 落空。
    // §7.4 竞态兜底：标记 canceled，spawn 返回后按 id 幂等补杀；runActive 期 kill 即时生效。
    s.canceled = true;
    s.runExit = undefined; // 关闭 tab 即复位，退出回调不再需要（实例移除由 hook 承担）
    s.runOnData = undefined;
    // IntegratedTerminal.dispose 在 started=true 时含 term_kill；started=false（invoke 在途）
    // 时 kill 落空——补杀由 runScriptInTerminal 返回路径的 killIfCanceled 承担
  }
  await s.iterm.dispose();
  s.view.remove();
  if (activeTermId === id) {
    activeTermId = termSessions[Math.min(idx, termSessions.length - 1)]?.id ?? null;
  }
  renderTerminalTabs();
  renderTerminalViews();
  // §7.1 不变式：运行 tab 被关 ⇒ 实例终止并复位（runFlow 侧移除实例 + 重绘运行组）
  if (s.kind === "run") runTabClosedHook?.(s.id);
}

/** 检查 preparing 竞态补偿（§7.4）：会话被取消（关闭 tab）后，invoke 返回时补杀后端进程。
 *  由 runScriptInTerminal 在 startRun 返回后调用——后端 TERMS 已登记，此时 kill 必命中。 */
async function killIfCanceled(s: TermSessionUI): Promise<void> {
  if (!s.canceled) return;
  await invoke("term_kill", { id: s.id }).catch(() => undefined);
}

/** UI-16：给「以 span/div 充当按钮」的元素补齐 button 语义 + 键盘激活。
 *  第四批待办的落地：role=generic 的 span 上 aria-label 不会被读屏暴露，且无 tabindex
 *  键盘不可达——补 role=button + tabindex=0 + Enter/Space 触发 click（复用既有 click 回调，
 *  单一动作入口；keydown 需 stopPropagation，避免冒泡到 tab 本体的方向键/回车处理）。 */
function makeSpanButton(el: HTMLElement, label: string): void {
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", label);
  el.tabIndex = 0;
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      ev.stopPropagation();
      el.click();
    }
  });
}

/** 重绘终端 tab 栏（含「＋」新建按钮） */
function renderTerminalTabs(): void {
  // UI-16：重绘会销毁正在聚焦的 tab 元素，先记录焦点、渲染后按会话 id 恢复，
  // 否则键盘用户每按一次方向键/回车焦点就掉回 body
  const ae = document.activeElement as HTMLElement | null;
  const focusedId = ae?.classList.contains("term-tab-add")
    ? "__add__"
    : (ae?.closest(".term-tab") as HTMLElement | null)?.dataset?.termId ?? null;
  terminalTabsEl.textContent = "";
  for (const s of termSessions) {
    const el = document.createElement("div");
    const active = s.id === activeTermId;
    // S3：运行终端用独立样式（§4.7 结论 2：与普通 shell 视觉区分）
    el.className = `term-tab${active ? " active" : ""}${s.kind === "run" ? " run" : ""}`;
    // UI-16：tabs 模式。tab 本体 role=tab + aria-selected（与 .active 同源）；
    // 漫游 tabindex（激活项 0、其余 -1）+ Enter/Space 激活 + ←→ 移动焦点；
    // 面板侧 .terminal-view 为 tabpanel（createTerminal 处声明）。
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(active));
    // 显式给定可访问名称：tab 名称默认从内容计算，会把子级停止/关闭按钮的
    // aria-label 一并混入（「终端 1 · pwsh 关闭终端」），故收敛为会话标题本身
    el.setAttribute("aria-label", termTitle(s));
    el.tabIndex = active ? 0 : -1;
    el.dataset.termId = s.id;
    // UI-09：tab 本体一并迁到 data-tip。原生 title 会沿祖先链继承解析——若父 tab 留 title、
    // 子级 stop/close 用 data-tip，悬停子级时两个提示会同时出现，故父子必须同轨。
    el.dataset.tip = termTitle(s);
    const name = document.createElement("span");
    name.className = "term-tab-name";
    name.textContent = termTitle(s);
    el.appendChild(name);
    // S3：运行中给一个停止按钮（按实例 id 路由，§17-5 / §10：各运行 tab 独立停止）
    if (s.kind === "run" && s.runActive) {
      const stop = document.createElement("span");
      stop.className = "term-tab-stop";
      stop.appendChild(codicon("debug-stop"));
      // UI-09：这两个是 <span> 而非 <button>（沿用既有结构，改成 button 需重置按钮默认样式）。
      // UI-16：已按第四批待办补齐 role/tabindex/键盘激活（见 makeSpanButton）。
      stop.dataset.tip = t("ide.term.stopTip", { label: s.label });
      makeSpanButton(stop, t("ide.term.stopTip", { label: s.label }));
      stop.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // §10：各运行 tab 独立停止——路由到 runFlow 的完整停止路径（进程 + 实例态收口）
        const viaHook = runTabStopHook?.(s.id);
        if (viaHook) void viaHook;
        else void stopRunInstanceById(s.id);
      });
      el.appendChild(stop);
    }
    const close = document.createElement("span");
    close.className = "term-tab-close";
    close.appendChild(codicon("close"));
    close.dataset.tip = s.kind === "run" ? t("ide.term.closeRunTip") : t("ide.term.closeTip");
    makeSpanButton(close, s.kind === "run" ? t("ide.term.closeRunTip") : t("ide.term.closeTip")); // UI-16
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void closeTerminal(s.id);
    });
    el.appendChild(close);
    el.addEventListener("click", () => activateTerminal(s.id));
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activateTerminal(s.id);
      } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        focusSiblingTermTab(el, ev.key === "ArrowRight" ? 1 : -1);
      }
    });
    terminalTabsEl.appendChild(el);
  }
  const add = document.createElement("div");
  add.className = "term-tab-add";
  add.appendChild(codicon("add"));
  add.dataset.tip = t("ide.term.newTip");
  // UI-16：非 tab 的动作按钮，不进 tablist 的漫游序列，但需键盘可达
  makeSpanButton(add, t("ide.term.newTip"));
  // UI-30：点击弹出 shell 选择菜单（menu.ts showMenu 以本元素为 anchor）——声明 haspopup，
  // aria-expanded 由 menu.ts 的触发元素跟踪统一切换（打开置 true、关闭复位 false）
  add.setAttribute("aria-haspopup", "menu");
  add.setAttribute("aria-expanded", "false");
  add.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void spawnShellMenu(add);
  });
  terminalTabsEl.appendChild(add);
  // 焦点恢复：按会话 id 找回新元素；原焦点在「＋」上则还给「＋」
  if (focusedId) {
    const target = focusedId === "__add__" ? add : terminalTabsEl.querySelector<HTMLElement>(`.term-tab[data-term-id="${CSS.escape(focusedId)}"]`);
    target?.focus();
  }
}

/** 终端 tab 的 ←→ 焦点漫游（跳过中间的停止/关闭小按钮，只在 tab 之间移动；越界环绕） */
function focusSiblingTermTab(from: HTMLElement, dir: 1 | -1): void {
  const tabs = Array.from(terminalTabsEl.querySelectorAll<HTMLElement>(".term-tab"));
  if (tabs.length < 2) return;
  const idx = tabs.indexOf(from);
  const next = tabs[(idx + dir + tabs.length) % tabs.length];
  next.focus();
}

/** UI-12：无会话时的兜底空态元素（懒建；一旦有会话即移除，避免与终端视图争空间） */
let termEmptyEl: HTMLElement | null = null;

/** 重绘终端视图（仅显示激活的那个） */
function renderTerminalViews(): void {
  for (const s of termSessions) {
    s.view.classList.toggle("hidden", s.id !== activeTermId);
  }
  // UI-12：会话数为 0 时渲染引导性空态。此前本函数只切换已有 view 的显隐，
  // 关掉最后一个终端后 #terminal-views 会彻底空白，用户切到「终端」标签无从下手。
  // 用 compact 档：底部面板高度有限（可拖到 120px），标准档的大留白会放不下。
  if (termSessions.length === 0) {
    if (!termEmptyEl) {
      termEmptyEl = emptyState(
        "terminal",
        t("ide.term.none"),
        t("ide.term.noneHint"),
        true,
      );
      termEmptyEl.classList.add("term-empty");
      terminalViewsEl.appendChild(termEmptyEl);
    }
  } else if (termEmptyEl) {
    termEmptyEl.remove();
    termEmptyEl = null;
  }
}

/** 外壳主题切换 → 所有终端实例重套配色（D1 P-01） */
export function refreshTerminalThemes(): void {
  for (const s of termSessions) s.iterm.applyTheme();
}

/** UI-11：「减少动画」开关切换 → 所有已存在的终端实例重设光标闪烁
 *  （新建实例在构造时已读开关，此处只负责补上切换前就存在的那些） */
export function refreshTerminalMotion(): void {
  for (const s of termSessions) s.iterm.applyMotionPreference();
}

/** UI-29：设置保存（字号/字体族）→ 所有已存在的终端实例重套字体并 refit
 *  （新建实例在构造时已读设置，此处只负责补上变更前就存在的那些——与 refreshTerminalMotion 同款模式） */
export function refreshTerminalFonts(): void {
  for (const s of termSessions) s.iterm.applyFontPreference();
}

/** 在指定目录新建终端（右键「在终端中打开」） */
export async function openTerminalAt(dir: string): Promise<void> {
  setBottomTab("terminal");
  await createTerminal(dir);
}

// ---------- S3：统一运行控制台（v3.4 §6/§17-5 按实例化） ----------

/** runScriptInTerminal 的启动参数（按实例化口径，§17-5） */
export interface RunTerminalOptions {
  /** 脚本路径（project 时被后端忽略，传 entry.target 占位） */
  path: string;
  /** 运行回显行（写在脚本输出之前） */
  echo: string;
  /** "script" | "project"（后端 kind 参数） */
  kind: "script" | "project";
  /** 显式指定实例 id（「项目 N」并行实例）；缺省按 kind 分配：
   *  script → run-term-script；project → run-term-project-1（主 tab） */
  instanceId?: string;
  /** probe 开关（缺省 = 后端按全局 probe_enabled 控制；选区运行传 false） */
  probe?: boolean;
  /** 按实例输出采集回调（运行历史入档，§11；ANSI 剥离在采集侧） */
  onData?: (text: string) => void;
  /** 按实例退出回调（自然退出；主动停止 / 关闭 tab 由 runFlow 侧收口） */
  onExit: (code: number) => void;
}

/** 在统一运行控制台运行（`terminal::run_in_terminal` → PTY 直跑解释器，不套 shell）。
 *
 * - **按实例化（§17-5）**：退出回调 / 输出采集 / tab 查找 / 停止路由全部按实例 id 绑定；
 * - **启动前确保 tab 存在，不存在则重建**（§7.1 不变式，根治「关掉终端再运行没地方输出」）；
 * - 会话 id 按后端约定分配（§17-12）：script → `run-term-script`；project → 主 tab
 *   `run-term-project-1` 或并行实例 `run-term-project-<N>`（N ≥ 2）；
 * - 生命周期与 shell 不同（§4.7 结论 2）：脚本跑完即结束会话，tab 保留供阅读输出与点击 traceback；
 * - 回显行与运行按钮同一口径（来源前缀 + 解释器完整路径 + 参数）。
 *
 * @throws 后端启动失败（已在终端里写下原因），调用方负责复位运行态 */
export async function runScriptInTerminal(opts: RunTerminalOptions): Promise<void> {
  const { path, echo, kind } = opts;
  // 实例 id 分配：脚本恒 run-term-script（全局唯一）；项目按 instanceId（主 tab=1 / 并行 N）
  const id = opts.instanceId ?? (kind === "project" ? "run-term-project-1" : "run-term-script");
  // 竞态护栏（§7.4 复查修复）：runState 实例在 preparing 期已被 stopRunById 收口（exited）
  // 或被关闭 tab 移除 → 本次 spawn 直接放弃（否则进程落地即孤儿——canceled 标记可能在
  // 会话创建前/后被抹，唯有以 runState 为准才可靠）。onExternalRunAbort 由 runFlow 注入。
  if (runAbortProbe?.(id)) return;
  // 启动前确保 tab 存在（§7.1 不变式）：查不到（被关闭 / 首次）则重建
  let s = termSessions.find((x) => x.id === id);
  const isNewSession = !s;
  if (!s) {
    const view = document.createElement("div");
    view.className = "terminal-view";
    terminalViewsEl.appendChild(view);
    const iterm = new IntegratedTerminal(id, view);
    iterm.setOnExit(() => renderTerminalTabs());
    const label = kind === "project"
      ? (id === "run-term-project-1" ? t("ide.term.project") : t("ide.term.projectN", { n: Number(id.slice("run-term-project-".length)) }))
      : t("ide.term.runLabel", { name: basename(path) });
    s = { id, label, venv: null, iterm, view, kind: "run", runKind: kind, runActive: false, shell: "auto" };
    termSessions.push(s);
    if (id !== "run-term-script" && id.startsWith("run-term-project-")) {
      const n = Number(id.slice("run-term-project-".length));
      if (Number.isFinite(n)) projectRunSeq = Math.max(projectRunSeq, n);
    }
  }
  // 按实例绑定回调（§17-5：每实例各自挂自己的退出回调与采集回调）。
  // canceled 只在新会话上清零：既有会话可能已被 stopRunById 标记 canceled（preparing 期
  // 停止），无条件清零会让 spawn 落地后的补杀失效 → 孤儿进程（复查修复）。
  s.runExit = opts.onExit;
  s.runOnData = opts.onData;
  if (isNewSession) s.canceled = false;
  if (kind === "script") s.label = t("ide.term.runLabel", { name: basename(path) });
  activeTermId = s.id;
  // **先落好运行终端再切标签**：setBottomTab 会触发 ensureAnyTerminal，
  // 顺序反了它会先建一个交互 shell 并把激活态抢走（用户看到的是 shell 而不是运行输出）
  setBottomTab("terminal");
  renderTerminalTabs();
  renderTerminalViews();
  s.iterm.relayout(); // 面板刚切过来，尺寸可能还没稳定（cols/rows 要准，否则 PTY 换行错位）

  try {
    const warnings = await s.iterm.startRun(path, app.workspaceRoot, echo, kind, opts.probe);
    // preparing 竞态兜底（§7.4）：tab 在 invoke 在途时被关闭（canceled）→ 后端 TERMS 此刻
    // 已登记，补杀必命中；未取消则正常进入运行态
    await killIfCanceled(s);
    if (s.canceled) return;
    s.runActive = true;
    // 非致命告警（如 Parameters 解析失败）写进终端（文案来自 run_env）
    for (const w of warnings) s.iterm.writeData(`\x1b[33m${w.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
    renderTerminalTabs();
  } catch (e) {
    s.runActive = false;
    renderTerminalTabs();
    throw e;
  }
}

/** 取消一个 preparing 期实例（runFlow 的 stopRunById 对未落地进程的停止语义，§7.4）：
 *  仅标记 canceled——spawn 落地后由 runScriptInTerminal 的 killIfCanceled 按 id 补杀。
 *  对已进入运行态（runActive）的会话无操作（那属于 stopRunInstanceById 的软杀路径）。 */
export function cancelRunInstance(id: string): void {
  const s = sessionById(id);
  if (s && !s.runActive) s.canceled = true;
}

/** 启动中止探针（runFlow 注册，§7.4 复查修复）：runScriptInTerminal 在 spawn 前询问
 *  「该实例是否已在 runState 侧被收口（exited）或移除（关闭 tab）」——是则放弃本次
 *  spawn。这堵住了「stopRunById 在 preparing 期收口实例，但 invoke 已在途、落地即孤儿」
 *  的窗口（canceled 标记可能晚于会话创建/清零，唯有 runState 是唯一真值）。 */
let runAbortProbe: ((id: string) => boolean) | null = null;

/** 注入启动中止探针（runFlow 的 wireRunFlow 注册） */
export function setRunAbortProbe(fn: (id: string) => boolean): void {
  runAbortProbe = fn;
}

/** 按实例 id 停止运行（runFlow 的 stopRunById / tab 停止按钮统一路由；幂等，§7.5）。
 * `term_kill` 不发 term-exit（只有自然退出才 notify），故由调用方（runFlow）收口实例态。
 * P1-J：软杀优先——先向 PTY 写 Ctrl+C（\x03，ConPTY 转换为控制台事件，uvicorn 等
 * 长驻服务可优雅退出），宽限 1.2s 未退再 term_kill 强杀。 */
export async function stopRunInstanceById(id: string): Promise<void> {
  const s = sessionById(id);
  if (!s || !s.runActive) return; // 幂等：对已结束实例无操作（§7.5 硬规则 3）
  await invoke("term_write", { id: s.id, data: "\x03" }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1200));
  await finalizeStoppedRunInstance(id);
}

/** 强杀 + UI 收尾（无宽限等待）：P2-2——批量停止的集中强杀阶段复用。
 *  软杀信号（\x03）已由调用方广播并共享等待过，此处只做 term_kill 与会话态复位。 */
export async function finalizeStoppedRunInstance(id: string): Promise<void> {
  await invoke("term_kill", { id }).catch(() => undefined);
  const s = sessionById(id);
  if (s) {
    s.runActive = false;
    s.iterm.markStopped();
  }
  renderTerminalTabs();
}

// ---------- 服务 URL 自动打开（§9 M3-3.9 + 框架探针表 P1：Uvicorn / Django / Flask） ----------

/** 用系统浏览器打开 URL（main 侧注入 open_external 的包装；仅 http/https） */
let externalUrlOpener: ((url: string) => void) | null = null;

/** 注入 URL 打开器（main 注册，避免 termUi 反向依赖 invoke 细节） */
export function setExternalUrlOpener(fn: (url: string) => void): void {
  externalUrlOpener = fn;
}

/** 兼容导出（runFlow 使用） */
export function openExternalUrl(url: string): void {
  externalUrlOpener?.(url);
}

/** 服务就绪行（§9 + 框架探针表 P1/F3）：各 dev server 的就绪行解析实际 URL
 *  （args 改 --port/--host 时天然正确，无需另配端口）。 */
const SERVICE_URL_RES: RegExp[] = [
  /Uvicorn running on (https?:\/\/\S+)/, // Uvicorn
  /Starting development server at (https?:\/\/\S+)/, // Django runserver
  /Running on (https?:\/\/\S+)/, // Flask / Werkzeug（"* Running on …"）与 Hypercorn（无星号前缀）
];

/** 就绪行关键词（快速路径）：避免每块输出都拼接缓冲 */
const SERVICE_URL_HINTS = ["Uvicorn running on", "development server at", "Running on"];

/** 跨块缓冲（§9 复查修复）：PTY 分块可能把就绪行从中间截断（`Uvicorn run` + `ning on …`），
 *  逐块匹配会漏——保留尾部一段（就绪行长度上限 512 字符足够）跨块拼接。 */
let serviceTail = "";

/** 按实例检测服务就绪行并打开浏览器（每项目每会话一次，§9）。
 *  挂在 term-data 分发点：任何项目运行实例（uvicorn / manage.py runserver / flask run 等）
 *  的输出中出现就绪行即解析 URL 并用系统浏览器打开。
 *  text 须为剥离 ANSI 后的纯文本（调用方保证）。 */
const serviceOpenedFor = new Set<string>();

/** 最近一次解析到的服务 origin（F2：端点直达浏览器的 base；端点侧栏消费）。
 *  origin 只含 scheme+host+port，拼接路由交给消费方（joinRoute）。 */
let lastServiceOrigin: string | null = null;

/** 读取服务 base（null = 本会话尚无运行中的 dev server 就绪行） */
export function lastServiceBaseUrl(): string | null {
  return lastServiceOrigin;
}

// E2E 钩子（同 debugGutter __OC_DEBUG_TEST__ 先例）：浏览器 mock 没有真实终端输出，
// 测试侧经此直接注入/读取服务 base，验收端点直达浏览器与 /docs、/openapi.json 入口。
(window as unknown as { __OC_E2E_SERVICE__?: { setServiceBase: (url: string | null) => void; getServiceBase: () => string | null } }).__OC_E2E_SERVICE__ = {
  setServiceBase: (url: string | null) => {
    lastServiceOrigin = url;
  },
  getServiceBase: () => lastServiceOrigin,
};

function watchServiceUrlLine(_id: string, text: string): void {
  // 已打开过的项目直接跳过（每项目每会话一次，§9），不积累缓冲
  const root = app.workspaceRoot ?? "";
  if (root && serviceOpenedFor.has(root)) return;
  // 快速路径：不含任何就绪行关键词且缓冲为空 → 无需拼接，直接返回
  if (!serviceTail && !SERVICE_URL_HINTS.some((k) => text.includes(k))) return;
  serviceTail = (serviceTail + text).slice(-512);
  let url: string | null = null;
  for (const re of SERVICE_URL_RES) {
    const m = re.exec(serviceTail);
    if (m) {
      url = m[1];
      break;
    }
  }
  if (!url) return;
  serviceTail = "";
  // 就绪行尾部可能带上句末标点（如 `at http://…:8000/.`），剥掉再打开
  const clean = url.replace(/[.,;:!?)\]]+$/u, "");
  if (!clean) return;
  try {
    lastServiceOrigin = new URL(clean).origin; // F2：端点直达浏览器取 origin（不含就绪行可能带的路径）
  } catch {
    /* 非法 URL 不更新 base，也不影响本次打开 */
  }
  if (root) serviceOpenedFor.add(root);
  externalUrlOpener?.(clean);
}

/** 执行高频命令（P2-6：一键插入或立即执行）。
 * 命令必须落到**交互 shell**：运行终端（S3）跑完即退，往里写命令没有意义。 */
async function runTerminalCommand(cmd: string, run: boolean): Promise<void> {
  setBottomTab("terminal");
  const s = await ensureShellTerminal();
  if (!s) return;
  if (!s.iterm.isRunning()) {
    // 激活终端已退出 → 重启它（保持同一 tab，沿用当初选的 shell，不被全局默认覆盖）
    s.venv = await s.iterm.start(defaultTerminalCwd(), app.workspaceRoot, s.shell);
    renderTerminalTabs();
    await new Promise((r) => setTimeout(r, 600));
  }
  s.iterm.sendCommand(cmd, run);
}

/** tab 停止按钮的停止回调（runFlow 注册：停止进程 + 收口实例态，§10 各 tab 独立停止） */
let runTabStopHook: ((id: string) => Promise<void>) | null = null;

/** 注入 tab 停止回调（runFlow 的 wireRunFlow 注册，路由到完整停止路径） */
export function setRunTabStopHook(fn: (id: string) => Promise<void>): void {
  runTabStopHook = fn;
}

/** 销毁所有终端并重置底部面板到「输出」标签（关闭/切换工作区时调用） */
export async function disposeTerminal(): Promise<void> {
  for (const s of termSessions) {
    await s.iterm.dispose();
    s.view.remove();
  }
  termSessions.length = 0;
  activeTermId = null;
  termSeq = 0;
  projectRunSeq = 1;
  serviceOpenedFor.clear();
  serviceTail = "";
  lastServiceOrigin = null;
  resetOutputChannelUi();
  renderTerminalTabs();
  bottomTab = "output";
  // class 与 aria-selected 同源切换（UI-16 单一写入点本应走 setBottomTab；此处是复位路径，
  // 不宜触发 ensureAnyTerminal 等副作用，故手动同步两态）
  for (const [id, active] of [
    ["tab-output", true], ["tab-terminal", false], ["tab-git-detail", false], ["tab-find-usages", false],
    ["tab-problems", false],
  ] as const) {
    $(id).classList.toggle("active", active);
    $(id).setAttribute("aria-selected", String(active));
  }
  outputEl.classList.remove("hidden");
  terminalPanelEl.classList.add("hidden");
  gitDetailPanelEl.classList.add("hidden");
  findUsagesPanelEl.classList.add("hidden");
  $("problems-panel").classList.add("hidden");
  // P0-2（2026-09-30 审计）：setBottomTab 管理的三个辅助元素显隐此前漏同步——
  // 关闭工作区前底部正显示终端 tab 时，复位到输出后：输出过滤 chips / 级别 chips 不出现、
  // 终端高频命令下拉残留在输出 tab 上。与 setBottomTab("output") 的三行同口径。
  $("terminal-cmd").classList.add("hidden");
  $("output-channels").classList.remove("hidden");
  $("output-levels").classList.toggle("hidden", !levelColorsEnabled());
}

// ---------- 事件接线 ----------

/** P1（UX 审查）：切换底部面板展开/收起（#btn-toggle-output 与键位 Alt+F12 共用唯一实现）。
 *  B 批：折叠态写穿 localStorage，启动时恢复（wireBottomPanel）。 */
const BOTTOM_COLLAPSED_KEY = "pylume.bottom_collapsed";

export function toggleBottomPanel(): void {
  const bottom = $("bottom");
  bottom.classList.toggle("collapsed");
  try {
    localStorage.setItem(BOTTOM_COLLAPSED_KEY, bottom.classList.contains("collapsed") ? "1" : "0");
  } catch {
    // 存储不可用：本次会话内仍生效
  }
  // 展开时若终端可见，重新 fit + resize（收起期间尺寸归零）
  if (!bottom.classList.contains("collapsed") && bottomTab === "terminal") {
    activeTermSession()?.iterm.relayout();
  }
}

/** 接线底部面板交互：标签切换 / 清空输出 / 展开收起 / 高频命令下拉 */
export function wireBottomPanel(): void {
  // B 批：恢复上次会话的折叠态（习惯收起终端的用户重启后不再重新展开）
  if (localStorage.getItem(BOTTOM_COLLAPSED_KEY) === "1") $("bottom").classList.add("collapsed");
  // 底部面板：输出 / 终端标签 + 清空 + 展开收起
  $("tab-output").addEventListener("click", () => setBottomTab("output"));
  $("tab-terminal").addEventListener("click", () => setBottomTab("terminal"));
  // Git 标签：无内容时渲染空态引导（show/blame 是被动填充，直接点击原本只有一片空白）
  $("tab-git-detail").addEventListener("click", () => {
    if (!hasGitDetailContent()) renderGitDetailEmptyState();
    setBottomTab("git");
  });
  $("tab-find-usages").addEventListener("click", () => setBottomTab("findUsages"));
  $("btn-clear-output").addEventListener("click", () => {
    outputHooks?.onClear(); // S4：先丢弃未完结行状态，再清空容器
    clearOutput(outputEl);
  });
  $("btn-toggle-output").addEventListener("click", toggleBottomPanel);
  // P2：输出 channel 过滤 chips（全部 / 调试 / 环境 / Git）——点击切过滤并重刷已有行
  $("output-channels").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest(".out-chip") as HTMLElement | null;
    if (!chip?.dataset.ch) return;
    setOutputChannelFilter(chip.dataset.ch as OutputChannel);
    refilterOutputChannel(outputEl);
    for (const c of $("output-channels").querySelectorAll(".out-chip")) {
      c.classList.toggle("active", c === chip);
    }
  });
  // P1（库支持 §7-1）：日志级别过滤 chips（多选 aria-pressed；默认全不选中 = 只着色不过滤，
  // 任一选中 = 只显示所选级别 + 未分级行）。ARIA 状态单一写入点：aria-pressed 与 .active 同源切换。
  $("output-levels").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest(".out-chip") as HTMLElement | null;
    if (!chip?.dataset.lvl || !levelColorsEnabled()) return;
    const pressed = chip.getAttribute("aria-pressed") !== "true";
    chip.setAttribute("aria-pressed", String(pressed));
    chip.classList.toggle("active", pressed);
    const active = Array.from(
      $("output-levels").querySelectorAll('.out-chip[aria-pressed="true"]'),
    ).map((c) => (c as HTMLElement).dataset.lvl as OutputLogLevel);
    setOutputLevelFilter(active.length > 0 ? active : null);
    refilterOutputLevels(outputEl);
  });
  // 高频命令下拉（P2-6）：选中即发送到终端
  ($("terminal-cmd") as HTMLSelectElement).addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    const idx = sel.selectedIndex;
    if (idx <= 0) return;
    const cmd = sel.options[idx].value;
    const run = sel.options[idx].dataset.run === "1";
    sel.selectedIndex = 0;
    void runTerminalCommand(cmd, run);
  });
}

/** P2：重置输出 channel 过滤到「全部」（关闭/切换工作区、运行历史重放前调用） */
export function resetOutputChannelUi(): void {
  setOutputChannelFilter(null);
  for (const c of $("output-channels").querySelectorAll(".out-chip")) {
    c.classList.toggle("active", (c as HTMLElement).dataset.ch === "all");
  }
  // P1（库支持 §7-1）：级别过滤一并复位到「不过滤」
  setOutputLevelFilter(null);
  for (const c of $("output-levels").querySelectorAll(".out-chip")) {
    c.classList.toggle("active", false);
    c.setAttribute("aria-pressed", "false");
  }
}

// ---------- ANSI 剥离（§11 运行历史采集；实现在 util.ts，纯函数同 basename 层） ----------

/** 接线终端 PTY 事件（P2-7 多会话）：按 id 分发到对应终端实例。
 *  v3.4 §11（M3-3.8）：运行会话的输出同时送历史采集（剥离 ANSI）与 Uvicorn 监听。 */
export async function wireTerminalEvents(): Promise<void> {
  // 启动即预取可用 shell 列表，让默认路径（右键「在终端中打开」/「命令…」落点）也能正确退化
  void fetchAvailableShells();
  await getCurrentWindow().listen<{ id: string; data: string }>("term-data", (e) => {
    const s = termSessions.find((x) => x.id === e.payload.id);
    if (!s) return;
    s.iterm.writeData(e.payload.data);
    // 剥离 ANSI 后的纯文本：运行历史采集（§11）/ 服务就绪行监听（§9）/ 包管理器完成摘要嗅探（M2 §4.4）共用。
    // 彩色输出中 URL 后可能紧跟重置码（\x1b[0m），对原始数据跑 \S+ 会把转义码吃进 URL（复查修复）
    const plain = stripAnsi(e.payload.data);
    if (s.kind === "run") {
      s.runOnData?.(plain);
      watchServiceUrlLine(s.id, plain);
    }
    // M4-3 §6.4：traceback 的 ModuleNotFoundError → toast +「安装」按钮（复核修复 #4：
    // shell 与 run 会话都喂——用户在 shell 手敲 `uv run main.py` 的报错同样要触达；
    // 按行喂入，跨块截断由 modNotFoundHinted 会话去重兜底，罕见漏检不误报）。
    for (const line of plain.split("\n")) handleTracebackLine(line);
    // M2 §4.4：shell 会话里用户手敲 uv/pip 装包 → 完成摘要嗅探触发环境信号（反馈 3-4：终端装包后
    // 红线随 restartEngine 消失）。run 会话也一并嗅探（正则足够特异，脚本极少打印装包完成摘要）。
    sniffTerminalOutput(plain);
  });
  await getCurrentWindow().listen<{ id: string; code?: number }>("term-exit", (e) => {
    const s = termSessions.find((x) => x.id === e.payload.id);
    if (!s) return;
    s.iterm.handleExit();
    // S3：运行终端里的脚本自然退出 → 按实例触发退出回调（runFlow 收口实例态），
    // tab 本身保留，供阅读输出与点击 traceback（§4.7 结论 2）
    if (s.kind === "run") {
      s.runActive = false;
      renderTerminalTabs();
      const code = typeof e.payload.code === "number" ? e.payload.code : 0;
      const exit = s.runExit;
      s.runExit = undefined;
      exit?.(code);
    }
  });
}
