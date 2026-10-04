// Python 环境面板域（TD-14 拆分，原 main.ts 的「Python 环境管理 P25-T05」段）：
// 解释器状态栏 / 环境面板（解释器选择 / venv 创建 / 包管理）/ 灯泡装包 /
// .venv 自动检测提示 / 工具链首启引导 / pip 与 toolchain 事件流。
// 域内私有状态（包列表 / outdated / 勾选集 / 会话内提示去重）留在本模块；
// currentInterpreter 为跨域共享（runFlow 的 prepareRun、main 的 startLsp 读），导出 live binding。
// startLsp 经 initEnvPanel 注入（restartEngine）——避免与 main 循环依赖（terminal.ts 先例）。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { app, $, $btn, lazyEl, outputEl } from "./state";
import { basename, codicon, errMsg, relativePathRaw, setBusy, spinIcon as utilSpinIcon, SNAKE_SVG } from "./util";
import { onLocaleChange, t } from "./i18n"; // 第六批 i18n：环境域动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { appendOutputLine } from "./output";
import { gotoFromLink } from "./tracebackLink";
import { openConfirm } from "./dialog";
import { hideEl, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { toast, toastFail } from "./toast";
import * as toolchain from "./toolchain";
import {
  NULL_DIST_WARNING, fixCommandPreview, latestDiff, resolveDistForInstall,
  resetDepHealth, runDepFix, runDepScan,
} from "./depHealth";

// ---------- 域内类型 ----------

interface PythonInfo { path: string; version: string; kind: string; is_selected: boolean }
interface PackageInfo { name: string; version: string }
/** Python 版本下拉项（venv 创建用，含可下载版本标记；新建项目域共用） */
export interface PythonVersionOption { version: string; spec: string; path: string | null; installed: boolean }
/** list_outdated 返回。字段名 = Rust OutdatedInfo 的 serde rename（latest_version /
 *  latest_filetype 双向生效，IPC 序列化即此名）——TS 侧曾用 latest/filetype 导致「有新版 undefined」。 */
interface OutdatedInfo { name: string; version: string; latest_version: string; latest_filetype: string }
/** create_venv 返回（新建项目域共用） */
export interface CreateVenvResult { output: string; python: string }

// ---------- 域内 DOM ----------
// P2-6（2026-09-29 review）：顶层快照改惰性（铁律 1，测试环境可 import）。
// $btn 改用 lazyEl<HTMLButtonElement>（$btn 无惰性变体，按钮按 id 解析语义相同）。

const statusInterpreterEl = lazyEl("status-interpreter");
const envModalEl = lazyEl("env-modal");
const envPackagesEl = lazyEl("env-packages");
const envPkgInputEl = lazyEl<HTMLInputElement>("env-pkg-input");
const envPkgFilterEl = lazyEl<HTMLInputElement>("env-pkg-filter");
const envPkgCountEl = lazyEl("env-pkg-count");
const envPkgUpgradeAllBtn = lazyEl<HTMLButtonElement>("env-pkg-upgrade-all");
const envPkgUninstallSelectedBtn = lazyEl<HTMLButtonElement>("env-pkg-uninstall-selected");
// 自定义解释器下拉（#2 决策 1=3b）：trigger + popover listbox + 创建流程的版本选择模态
const interpTriggerEl = lazyEl<HTMLButtonElement>("interp-trigger");
const interpLabelEl = lazyEl("interp-trigger-label");
const interpPopoverEl = lazyEl("interp-popover");
const interpSelectEl = lazyEl("interp-select");
const venvVersionModalEl = lazyEl("venv-version-modal");
const venvVersionListEl = lazyEl("venv-version-list");
const venvVersionHintEl = lazyEl("venv-version-hint");
// 原 env-pyproject-banner / env-pyproject-init 已退役（dep plan M3）：bare 引导横幅并入
// dep-health-banner 四级优先级（§6.2 优先级 2），由 depHealthPanel.ts 渲染（动作仍是 init_pyproject）。

// ---------- 域内状态 ----------

/** 当前工作区解释器（null = uv run 兜底）；runFlow / main 跨域读取 */
export let currentInterpreter: string | null = null;
/** 本轮会话是否已提示过 .venv 自动检测 */
const venvPrompted = new Set<string>();
/** 最近一次 list_pythons 结果（自定义下拉 popover 的渲染数据源；renderEnvPanel 刷新） */
let lastPythons: PythonInfo[] = [];
/** 工作区是否存在 .venv（态A/B 判定：无=强引导创建，有=重建需 danger 确认，#2 决策） */
let hasWorkspaceVenv = false;
/** 解释器下拉开合态 + popover 键盘导航高亮索引 */
let interpOpen = false;
let interpActiveIdx = -1;
/** 态A「无环境」一次性 toast 去重（打开工作区时，复用 venvPrompted 会话去重模式） */
const noEnvPrompted = new Set<string>();
/** 环境面板包列表状态 */
let currentPackages: PackageInfo[] = [];
let outdatedPackages: Map<string, OutdatedInfo> = new Map();
let selectedPkgs: Set<string> = new Set();
/** 包筛选关键词（小写）；空 = 不过滤 */
let pkgFilter = "";
/** CR-20：包列表刷新令牌——快速切解释器时，解释器 A 的 outdated 不得标到 B 的包上 */
let pkgToken = 0;
/** 解释器切换串行队列（尾部链式）：切换 = resetDepHealth + runDepScan + restartEngine，
 *  耗时数秒且必须按序完成；连点两个解释器时若并发跑会交错重启引擎。乐观 UI 先行（选中态立即变化），
 *  队列在后台消化——面板不再「卡住」。 */
let interpreterSwitchChain: Promise<void> = Promise.resolve();
/** UI-05：环境面板焦点陷阱解除句柄，关闭时置 null */
let releaseEnvFocus: (() => void) | null = null;
/** installMissingPackage 装完后重启静态引擎（initEnvPanel 注入 startLsp） */
let restartEngine: () => Promise<void> = () => Promise.resolve();

/** §4.6/§5.2 环境层事实变化的统一收尾（M3 完整协议形态）：
 *  ① 作废旧快照——环境事实已变，30s 新鲜窗口内的旧快照不可信（v1.3 ⑫）；
 *  ② 重算 diff——面板/灯泡/预检拿到收敛后的新真值（§5.2 第一步；onScanComplete 联动
 *     健康面板与状态栏图标）；
 *  ③ 重启静态引擎刷新诊断（R3）。
 *  toast（第三步）由各调用点的成功/失败分支就地发（文案贴合具体动作，memory 61552154）。 */
async function afterEnvChanged(): Promise<void> {
  resetDepHealth();
  const root = app.workspaceRoot;
  if (root) await runDepScan(root);
  await restartEngine();
}

// ---------- 状态栏 ----------

/** 解释器路径短名（.venv / 文件名）；runFlow 的回显与 prepareRun 复用（来源前缀判定） */
export function shortInterpreter(p: string): string {
  if (app.workspaceRoot && p.startsWith(app.workspaceRoot)) {
    const rel = p.slice(app.workspaceRoot.length).replace(/^[\\/]/, "");
    if (rel.startsWith(".venv")) return ".venv";
  }
  return basename(p);
}

function pythonLabel(p: PythonInfo): string {
  const ver = p.version ? ` ${p.version}` : "";
  if (p.kind === "workspace-venv") return t("env.kind.workspaceVenv", { ver: ver });
  if (p.kind === "manual") return t("env.kind.manualVenv", { ver: ver });
  // 兜底：无版本号的系统 Python 也只放文件名（完整路径会顶爆原生 select 弹层宽度）；
  // 完整路径由右侧披露行展示
  return p.version || basename(p.path);
}

/** 包名 PEP 503 归一化（前端轻量版，仅用于与 envDrift.dist 比对）：小写 + 连续 [-_.] → 单 - */
function normalizeDistName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export async function refreshInterpreterStatus(): Promise<void> {
  if (!app.workspaceRoot) {
    statusInterpreterEl.textContent = "";
    currentInterpreter = null;
    return;
  }
  try {
    currentInterpreter = await invoke<string | null>("get_interpreter", { workspaceRoot: app.workspaceRoot });
  } catch {
    currentInterpreter = null;
  }
  // D2：品牌蛇形单色图标 + 解释器标签（textContent 拼接防注入）
  // P1（建议 2）：状态栏升级为“解释器来源 + 版本”（(.venv) 3.13.x / uv run），运行前即可感知用哪套环境。
  let label: string;
  if (currentInterpreter) {
    const short = shortInterpreter(currentInterpreter);
    const srcTag = short === ".venv" ? "(.venv)" : short;
    let ver = "";
    try {
      ver = await invoke<string>("interpreter_version", { path: currentInterpreter });
    } catch {
      ver = ""; // 版本查询失败降级为仅显示来源，不阻断
    }
    label = ver ? `${srcTag} ${ver}` : srcTag;
  } else {
    label = "uv run";
  }
  const snake = document.createElement("span");
  snake.className = "status-snake";
  snake.innerHTML = SNAKE_SVG; // 常量 SVG
  statusInterpreterEl.replaceChildren(snake, ` ${label}`);
}

/** 关闭工作区时清空解释器状态栏（main 的 closeWorkspace 调用） */
export function clearInterpreterStatus(): void {
  statusInterpreterEl.textContent = "";
}

/** 切换/关闭工作区时的环境域复位（原 resetEnvPackages + pkgToken / currentInterpreter / venvPrompted 清理）：
 * 清空包列表状态与面板块 DOM + 作废在途请求 + 防切换瞬间误用旧解释器；不主动触发 renderPackages，
 * 避免切换瞬间联网查询。 */
export function resetEnvPanelState(): void {
  currentPackages = [];
  outdatedPackages.clear();
  selectedPkgs.clear();
  pkgFilter = "";
  envPkgFilterEl.value = "";
  envPackagesEl.textContent = "";
  updatePkgToolbar();
  pkgToken++;
  currentInterpreter = null;
  venvPrompted.clear();
  noEnvPrompted.clear();
  lastPythons = [];
  hasWorkspaceVenv = false;
  closeInterp();
  // P2（2026-09-30 审计）：面板开着时关工作区 → 此前只清包区 DOM 留下头部信息残留的
  // 孤儿半清空面板。直接关闭模态（数据层已清，留着无意义且各按钮已失效）。
  if (!envModalEl.classList.contains("hidden")) closeEnvPanel();
}

// ---------- 环境面板 ----------

/** 面板打开钩子（main 注册 depHealthPanel.renderDepHealth——避免 envPanel ↔ depHealthPanel 循环依赖） */
const openedHooks: Array<() => void> = [];
export function onEnvPanelOpened(cb: () => void): void {
  openedHooks.push(cb);
}

export async function openEnvPanel(): Promise<void> {
  if (!app.workspaceRoot) return;
  showEl(envModalEl);
  // UI-30：解释器芯片（aria-haspopup=dialog）的开合态，与 envModal 显隐同源切换（第七批留给本批的待办）
  statusInterpreterEl.setAttribute("aria-expanded", "true");
  releaseEnvFocus?.();
  releaseEnvFocus = trapFocus(envModalEl);
  // §6.5 模态范式对齐（memory 67600367）：点遮罩不关闭 + Esc 关闭（runConfigPanel 范式）
  document.addEventListener("keydown", onEnvKeydown);
  for (const cb of openedHooks) cb();
  await renderEnvPanel();
}

function closeEnvPanel(): void {
  releaseEnvFocus?.();
  releaseEnvFocus = null;
  document.removeEventListener("keydown", onEnvKeydown);
  hideEl(envModalEl);
  statusInterpreterEl.setAttribute("aria-expanded", "false"); // UI-30
}

/** Esc 关闭环境面板（点遮罩不关闭后，Esc 与 X 按钮并列为键盘/鼠标关闭入口）。
 *  守卫：前台还有更上层对话框（openConfirm/openAlert/openPrompt 均走 .modal 显隐约定）时
 *  Esc 归对话框——其处理器挂在按钮 keydown 上，事件仍会冒泡到 document，不挡会连带
 *  关掉底下的环境面板（如「全部修复」确认框按 Esc 取消时面板不应消失）。 */
function onEnvKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (document.querySelectorAll(".modal:not(.hidden)").length > 1) return;
  closeEnvPanel();
}

/** 面板可见时刷新包列表（depHealthPanel 修复动作收尾后调用——dep_fix 装/卸包会改环境内容） */
export function refreshPackagesIfOpen(): void {
  if (!envModalEl.classList.contains("hidden")) void renderPackages();
}

/** 体检完成后仅本地重绘包行（#4：「未声明」徽标随 latestDiff 更新）——不联网重拉包/outdated，
 *  区别于 refreshPackagesIfOpen（装/卸包后环境内容真变了才用）。面板未开则跳过。 */
export function repaintPkgBadgesIfOpen(): void {
  if (!envModalEl.classList.contains("hidden")) renderPkgLines();
}

/** option 文本的路径缩写（控制原生弹层宽度——弹层随最长 option 扩张、不受 CSS 约束，
 *  完整路径会顶出卡片）：工作区内先相对化（relativePathRaw 保留原样大小写与分隔符），
 *  再统一「首尾省略」——保留头两段与尾两段、中间折为省略号并加括号，如
 *  (<temp>\Python311\python.exe)；≤4 段无需省略，原样进括号。
 *  完整路径由 select / option 的 title 悬停披露。 */
function optionPathHint(p: string): string {
  const rel = app.workspaceRoot ? relativePathRaw(app.workspaceRoot, p) : null;
  const shown = rel ?? p;
  const parts = shown.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 4) return `(${shown})`;
  const sep = shown.includes("\\") ? "\\" : "/";
  return `(${parts.slice(0, 2).join(sep)}${sep}…${sep}${parts.slice(-2).join(sep)})`;
}

/** 解释器 trigger 的标签与悬停 title 同步（当前选中项标签 + 缩写路径；完整路径走 title）。
 *  自定义下拉取代原生 select 后，title 挂在 trigger 按钮上（UI-09 规则 3：表单控件保留原生 title）。 */
function syncInterpreterTrigger(): void {
  const sel = lastPythons.find((p) => p.path === currentInterpreter) ?? lastPythons.find((p) => p.is_selected);
  interpLabelEl.textContent = currentInterpreter
    ? t("env.interp.label", { name: sel ? pythonLabel(sel) : t("env.kind.manualPlain"), hint: optionPathHint(currentInterpreter) })
    : t("env.interp.defaultUvRun");
  interpTriggerEl.title = currentInterpreter ?? t("env.interp.notSetHint");
}

async function renderEnvPanel(): Promise<void> {
  if (!app.workspaceRoot) return;
  let pythons: PythonInfo[] = [];
  try {
    pythons = await invoke<PythonInfo[]>("list_pythons", { workspaceRoot: app.workspaceRoot });
  } catch (e) {
    console.error("list_pythons 失败", e);
  }

  // 原 bare 横幅检测（has_pyproject）已并入 depHealthPanel.renderDepHealth 的四级横幅（§6.2）

  // 自定义解释器下拉（#2 决策 1=3b）：数据落 lastPythons，trigger 标签即时同步；
  // popover 内容在每次打开时渲染（openInterp → renderInterpPopover），保证选中态最新。
  // 版本下拉已移除（#2 决策 2：版本选择收进「创建 .venv」流程的版本弹窗）。
  lastPythons = pythons;
  hasWorkspaceVenv = pythons.some((p) => p.kind === "workspace-venv");
  syncInterpreterTrigger();
  renderNoEnvBanner();

  await renderPackages();
}

// 原 generatePyproject 已迁至 depHealthPanel.ts（bare 横幅动作，仍调 init_pyproject）

/** 解释器切换收尾（afterEnvChanged 的串行队列封装）：resetDepHealth + runDepScan + restartEngine
 *  耗时数秒，乐观 UI 先行后由本队列后台消化，连点切换按序执行不并发。 */
function enqueueInterpreterSwitch(): void {
  interpreterSwitchChain = interpreterSwitchChain
    .then(() => afterEnvChanged())
    .catch((e) => console.error("[envPanel] 解释器切换收尾失败", e));
}

async function selectInterpreter(path: string | null): Promise<void> {
  if (!app.workspaceRoot) return;
  if (path === currentInterpreter) return;
  try {
    await invoke("set_interpreter", { workspaceRoot: app.workspaceRoot, path });
  } catch (e) {
    toastFail(t("env.fail.setInterpreter"), e);
    void renderEnvPanel(); // 失败回滚下拉显示
    return;
  }
  // 乐观更新：下拉选中态与状态栏立即跟随；包列表按新解释器重载；
  // dep 扫描 + 引擎重启转后台队列（不阻塞面板）
  currentInterpreter = path;
  await refreshInterpreterStatus();
  syncInterpreterTrigger(); // trigger 标签与悬停 title 跟随新选中项
  void renderPackages();
  enqueueInterpreterSwitch();
}

// ---------- 自定义解释器下拉（#2 决策 1=3b：trigger + popover listbox + 底部动作行） ----------

/** popover 解释器项（role=option）；path="" 表示「（默认）uv run」 */
function interpItemEl(path: string, label: string, hint: string, selected: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = "interp-item";
  el.setAttribute("role", "option");
  el.setAttribute("aria-selected", String(selected));
  el.title = path || t("env.interp.notSetHint");
  const check = document.createElement("span");
  check.className = "interp-item-check";
  if (selected) check.appendChild(codicon("check"));
  const lbl = document.createElement("span");
  lbl.className = "interp-item-label";
  lbl.textContent = label;
  const p = document.createElement("span");
  p.className = "interp-item-path";
  p.textContent = hint;
  el.append(check, lbl, p);
  el.addEventListener("click", () => { closeInterp(); void selectInterpreter(path === "" ? null : path); });
  return el;
}

/** popover 底部动作行（创建/重建、浏览） */
function interpActionEl(icon: string, label: string, accent: boolean, run: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `interp-action${accent ? " accent" : ""}`;
  el.appendChild(codicon(icon));
  const span = document.createElement("span");
  span.textContent = label;
  el.appendChild(span);
  el.addEventListener("click", () => { closeInterp(); run(); });
  return el;
}

/** 渲染 popover：分组（工作区 / 系统·uv / 手动）+ 分隔 + 动作行。每次打开重建，选中态最新。 */
function renderInterpPopover(): void {
  interpPopoverEl.textContent = "";
  interpPopoverEl.appendChild(interpItemEl("", t("env.interp.defaultUvRun"), t("env.interp.unspecified"), !currentInterpreter));
  const groups: Array<[string, string[]]> = [
    [t("env.group.workspace"), ["workspace-venv"]],
    [t("env.group.systemUv"), ["system"]],
    [t("env.kind.manualPlain"), ["manual"]],
  ];
  for (const [title, kinds] of groups) {
    const items = lastPythons.filter((p) => kinds.includes(p.kind));
    if (items.length === 0) continue;
    const lbl = document.createElement("div");
    lbl.className = "interp-group-label";
    lbl.textContent = title;
    interpPopoverEl.appendChild(lbl);
    for (const p of items) {
      interpPopoverEl.appendChild(
        interpItemEl(p.path, pythonLabel(p), optionPathHint(p.path), p.path === currentInterpreter),
      );
    }
  }
  const sep = document.createElement("div");
  sep.className = "interp-sep";
  interpPopoverEl.appendChild(sep);
  // 态A（无 .venv）高亮「创建」；态B（有 .venv）降级「重建」（点击走 danger 确认）
  interpPopoverEl.appendChild(interpActionEl(
    hasWorkspaceVenv ? "trash" : "add",
    hasWorkspaceVenv ? t("env.action.rebuildVenv") : t("env.action.createVenvMenu"),
    !hasWorkspaceVenv,
    () => void onCreateVenv(),
  ));
  interpPopoverEl.appendChild(interpActionEl("folder-opened", t("env.action.browseInterpreter"), false, () => void browseInterpreter()));
}

function popoverFocusables(): HTMLElement[] {
  return Array.from(interpPopoverEl.querySelectorAll<HTMLElement>(".interp-item, .interp-action"));
}

function openInterp(): void {
  if (interpOpen) return;
  renderInterpPopover();
  interpOpen = true;
  interpPopoverEl.classList.remove("hidden");
  interpTriggerEl.setAttribute("aria-expanded", "true");
  document.addEventListener("mousedown", onInterpOutside, true);
  document.addEventListener("keydown", onInterpKeydown, true);
  const items = popoverFocusables();
  interpActiveIdx = Math.max(0, items.findIndex((el) => el.getAttribute("aria-selected") === "true"));
  updateInterpActive();
}

function closeInterp(): void {
  if (!interpOpen) return;
  interpOpen = false;
  interpPopoverEl.classList.add("hidden");
  interpTriggerEl.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", onInterpOutside, true);
  document.removeEventListener("keydown", onInterpKeydown, true);
  interpActiveIdx = -1;
}

function onInterpOutside(e: MouseEvent): void {
  if (!interpSelectEl.contains(e.target as Node)) closeInterp();
}

function updateInterpActive(): void {
  const items = popoverFocusables();
  items.forEach((el, i) => el.classList.toggle("active", i === interpActiveIdx));
  items[interpActiveIdx]?.scrollIntoView({ block: "nearest" });
}

function onInterpKeydown(e: KeyboardEvent): void {
  const items = popoverFocusables();
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeInterp(); interpTriggerEl.focus(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); interpActiveIdx = (interpActiveIdx + 1) % items.length; updateInterpActive(); return; }
  if (e.key === "ArrowUp") { e.preventDefault(); interpActiveIdx = (interpActiveIdx - 1 + items.length) % items.length; updateInterpActive(); return; }
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); items[interpActiveIdx]?.click(); }
}

// ---------- 浏览选择解释器（#2 决策 3：open + 版本校验，无效不落配置） ----------

async function browseInterpreter(): Promise<void> {
  const picked = await openDialog({
    title: t("env.dialog.pickTitle"),
    multiple: false,
    filters: [{ name: t("env.dialog.pythonFilter"), extensions: ["exe"] }],
  });
  if (typeof picked !== "string" || !picked) return; // 取消
  let ver = "";
  try { ver = await invoke<string>("interpreter_version", { path: picked }); } catch { ver = ""; }
  if (!ver) {
    toastFail(t("env.fail.pick"), t("env.invalidInterpreter", { name: basename(picked) }));
    return;
  }
  await selectInterpreter(picked); // 复用收尾；以 manual 出现在下拉
  syncInterpreterTrigger();
  toast(t("env.switched", { name: basename(picked), ver: ver }), "success");
}

// ---------- 创建 / 重建 .venv（#2 决策 2：版本选择收进创建流程；态B danger 确认） ----------

/** 态B（有 .venv）先 danger 确认（明示清空 N 包），再开版本弹窗；态A 直接开版本弹窗。 */
async function onCreateVenv(): Promise<void> {
  if (!app.workspaceRoot) return;
  if (hasWorkspaceVenv) {
    const n = currentPackages.length;
    const ok = await openConfirm({
      title: t("env.dialog.rebuildTitle"),
      message:
        // 确认语多段拼装（含 \n\n 不走 apply_ts 映射，避免语言包转义链失真），按段取词
        `${t("env.rebuildExists", { note: n > 0 ? t("env.rebuildPkgNote", { count: n }) : "" })}\n\n` +
        `${t("env.rebuildWarn")}\n\n${t("env.rebuildConfirm")}`,
      okLabel: t("env.action.rebuild"),
      cancelLabel: t("env.confirm.cancel"),
      kind: "danger",
    });
    if (!ok) return;
  }
  await openVersionModal();
}

/** 版本选择弹窗：列 list_python_versions，点击即创建；态B 顶部显示清空警示。 */
async function openVersionModal(): Promise<void> {
  let versions: PythonVersionOption[] = [];
  try { versions = await invoke<PythonVersionOption[]>("list_python_versions"); } catch (e) {
    console.error("list_python_versions 失败", e);
  }
  venvVersionListEl.textContent = "";
  if (versions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint-text";
    empty.textContent = t("env.versions.none");
    venvVersionListEl.appendChild(empty);
  }
  for (const v of versions) {
    const item = document.createElement("div");
    item.className = "venv-version-item";
    item.setAttribute("role", "option");
    const name = document.createElement("span");
    name.textContent = v.version;
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = v.installed ? t("env.tag.installed") : t("env.tag.needDownload");
    item.append(name, spacer, tag);
    item.addEventListener("click", () => { closeVersionModal(); void createVenv(v.spec); });
    venvVersionListEl.appendChild(item);
  }
  if (hasWorkspaceVenv) {
    venvVersionHintEl.textContent = t("env.rebuildHint", { note: currentPackages.length > 0 ? t("env.rebuildPkgNoteParen", { count: currentPackages.length }) : "" });
    venvVersionHintEl.classList.remove("hidden");
  } else {
    venvVersionHintEl.classList.add("hidden");
  }
  showEl(venvVersionModalEl);
  document.addEventListener("keydown", onVersionKeydown);
  const items = Array.from(venvVersionListEl.querySelectorAll<HTMLElement>(".venv-version-item"));
  const defIdx = Math.max(0, items.findIndex((el) => el.querySelector(".tag")?.textContent === t("env.tag.installed")));
  items.forEach((el, i) => el.classList.toggle("active", i === defIdx));
  items[defIdx]?.scrollIntoView({ block: "nearest" });
  venvVersionListEl.dataset.active = String(defIdx);
}

function closeVersionModal(): void {
  hideEl(venvVersionModalEl);
  document.removeEventListener("keydown", onVersionKeydown);
}

function onVersionKeydown(e: KeyboardEvent): void {
  const items = Array.from(venvVersionListEl.querySelectorAll<HTMLElement>(".venv-version-item"));
  if (e.key === "Escape") { e.preventDefault(); closeVersionModal(); return; }
  if (items.length === 0) return;
  let active = Number(venvVersionListEl.dataset.active ?? 0);
  if (e.key === "ArrowDown") active = (active + 1) % items.length;
  else if (e.key === "ArrowUp") active = (active - 1 + items.length) % items.length;
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); items[active]?.click(); return; }
  else return;
  e.preventDefault();
  items.forEach((el, i) => el.classList.toggle("active", i === active));
  items[active]?.scrollIntoView({ block: "nearest" });
  venvVersionListEl.dataset.active = String(active);
}

// ---------- 态A 强引导（#2 决策 4：无环境时面板常驻警示横幅） ----------

/** 无环境（无 .venv 且未选解释器）→ 解释器区上方常驻警示横幅；有环境则隐藏。
 *  横幅 DOM 动态确保（getElementById 容忍首次不存在），插到 .env-section--interp 之前。 */
function renderNoEnvBanner(): void {
  const noEnv = !hasWorkspaceVenv && !currentInterpreter;
  let banner = document.getElementById("env-noenv-banner");
  if (!noEnv) { banner?.classList.add("hidden"); return; }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "env-noenv-banner";
    banner.className = "env-banner env-banner--warn";
    const text = document.createElement("span");
    text.className = "env-banner-text";
    text.textContent = t("env.empty.noEnv");
    const actions = document.createElement("span");
    actions.className = "dep-banner-actions";
    const btn = document.createElement("button");
    btn.className = "btn btn--sm btn--primary";
    btn.textContent = t("env.action.createVenvBtn");
    btn.addEventListener("click", () => void onCreateVenv());
    actions.appendChild(btn);
    banner.append(text, actions);
    const interpSection = document.querySelector("#env-modal .env-section--interp");
    interpSection?.parentNode?.insertBefore(banner, interpSection);
  }
  banner.classList.remove("hidden");
}

// ---------- 包管理 ----------

/** 根据当前选择与 outdated 状态刷新包工具栏按钮与计数 */
function updatePkgToolbar(): void {
  envPkgCountEl.textContent = currentPackages.length ? `（${currentPackages.length}）` : "";
  envPkgUninstallSelectedBtn.disabled = selectedPkgs.size === 0;
  envPkgUpgradeAllBtn.disabled = !currentInterpreter || outdatedPackages.size === 0;
}

/** 包列表加载占位（内联转圈） */
function renderPkgLoading(msg: string): void {
  envPackagesEl.textContent = "";
  const line = document.createElement("div");
  line.className = "hint-text"; // UI-12：.env-empty 更名为中性的 .hint-text（此处是加载态提示）
  line.appendChild(utilSpinIcon());
  line.append(` ${msg}`);
  envPackagesEl.appendChild(line);
}

/** 当前筛选条件下应展示的包（名称子串匹配，大小写不敏感） */
function visiblePackages(): PackageInfo[] {
  if (!pkgFilter) return currentPackages;
  const q = pkgFilter.toLowerCase();
  return currentPackages.filter((p) => p.name.toLowerCase().includes(q));
}

/** 渲染包行（复用：首次快速渲染无 outdated 标记，后台补齐 outdated 后再渲染一次） */
function renderPkgLines(): void {
  envPackagesEl.textContent = "";
  const shown = visiblePackages();
  // #4：E3 漂移包（已装未声明）归一化名集合——包行加「未声明」徽标，连通包管理与依赖健康；
  // latestDiff 未就绪（尚未体检）时为空集，不显示标记（体检完成后下次渲染补上）
  const driftSet = new Set((latestDiff()?.envDrift ?? []).map((d) => normalizeDistName(d.dist)));
  if (currentPackages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint-text"; // UI-12：.env-empty 更名为中性的 .hint-text（样式不变）
    empty.textContent = t("env.pkgs.none");
    envPackagesEl.appendChild(empty);
    updatePkgToolbar();
    return;
  }
  if (shown.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint-text";
    empty.textContent = t("env.pkgs.noMatch");
    envPackagesEl.appendChild(empty);
    return;
  }
  for (const p of shown) {
    const line = document.createElement("div");
    line.className = "env-pkg-line";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "pkg-check";
    check.checked = selectedPkgs.has(p.name);
    check.title = t("env.pkgs.selectToUninstall");
    check.addEventListener("change", () => {
      if (check.checked) selectedPkgs.add(p.name);
      else selectedPkgs.delete(p.name);
      updatePkgToolbar();
    });

    const n = document.createElement("span");
    n.className = "pkg-name";
    n.textContent = p.name;
    n.title = p.name; // 截断披露（grid 列宽固定，长包名省略）
    // #4：E3 漂移包加「未声明」徽标（与依赖健康 E3 同一事实，包管理主视图也能感知）
    if (driftSet.has(normalizeDistName(p.name))) {
      const tag = document.createElement("span");
      tag.className = "pkg-drift-tag";
      tag.textContent = t("env.tag.notDeclared");
      tag.dataset.tip = t("env.tag.driftTip");
      n.appendChild(tag);
    }
    const v = document.createElement("span");
    v.className = "pkg-version";
    v.textContent = p.version;
    v.title = p.version;
    line.append(check, n, v);

    const od = outdatedPackages.get(p.name);
    // 过时列：有新版 = warn 色升级箭头（版本细节进悬停 tip，不再用文字徽章——96 行黄字太吵）；
    // 无新版放空占位 span 保住 grid 列对齐
    if (od) {
      const upBtn = document.createElement("button");
      upBtn.className = "codicon codicon-arrow-up pkg-upgrade";
      // UI-09：className 本身就是 codicon（无内部 <i>、无文本内容），可访问名称由 aria-label 承担
      upBtn.dataset.tip = t("env.pkg.upgradeTip", { name: p.name, from: od.version, to: od.latest_version });
      upBtn.setAttribute("aria-label", t("env.pkg.upgradeAria", { name: p.name, to: od.latest_version }));
      upBtn.addEventListener("click", () => { void upgradePackage(p.name); });
      line.append(upBtn);
    } else {
      line.append(document.createElement("span"));
    }
    const rmBtn = document.createElement("button");
    rmBtn.className = "codicon codicon-trash danger";
    rmBtn.dataset.tip = t("env.pkg.uninstallTip", { name: p.name });
    rmBtn.setAttribute("aria-label", t("env.pkg.uninstallTip", { name: p.name }));
    rmBtn.addEventListener("click", () => { void uninstallPackages([p.name]); });
    line.append(rmBtn);

    envPackagesEl.appendChild(line);
  }
  updatePkgToolbar();
}

async function renderPackages(): Promise<void> {
  updatePkgToolbar();
  if (!currentInterpreter) {
    envPackagesEl.textContent = "";
    const empty = document.createElement("div");
    empty.className = "hint-text"; // UI-12：.env-empty 更名为中性的 .hint-text（样式不变）
    empty.textContent = t("env.pkgs.pickFirst");
    envPackagesEl.appendChild(empty);
    currentPackages = [];
    outdatedPackages.clear();
    selectedPkgs.clear();
    updatePkgToolbar();
    return;
  }
  const interp = currentInterpreter;
  const token = ++pkgToken;
  // CR-20 补漏：开局即清旧解释器的 outdated——令牌只防「晚到的写回」，防不了
  // 「B 的首帧沿用 A 的 Map」：切到 B 后第一次 renderPkgLines 若不清，同名包会被
  // 错标「有新版」且「升级全部」短暂可点
  outdatedPackages.clear();
  renderPkgLoading(t("env.pkgs.loading"));
  // 先快速加载已装包并渲染：outdated 查询可能联网较慢，后台补齐不阻塞列表展示
  const pkgs = await invoke<PackageInfo[]>("list_packages", { interpreter: interp }).catch(() => [] as PackageInfo[]);
  if (token !== pkgToken || currentInterpreter !== interp) return; // 已切解释器，丢弃旧结果
  currentPackages = pkgs;
  selectedPkgs = new Set([...selectedPkgs].filter((n) => pkgs.some((p) => p.name === n)));
  renderPkgLines();

  const outdated = await invoke<OutdatedInfo[]>("list_outdated", { interpreter: interp }).catch(() => [] as OutdatedInfo[]);
  if (token !== pkgToken || currentInterpreter !== interp) return;
  outdatedPackages = new Map(outdated.map((o) => [o.name, o]));
  renderPkgLines();
}

async function createVenv(version: string): Promise<void> {
  if (!app.workspaceRoot) return;
  const cmdDesc = `uv venv .venv${version ? " --python " + version : ""}  (${app.workspaceRoot})`;
  appendOutputLine(outputEl, `> ${cmdDesc}`, "cmd", gotoFromLink, "env");
  // 问题1 友好交互：展开输出面板——uv 下载 Python / 创建环境的流式进度是唯一的进度反馈
  $("bottom").classList.remove("collapsed");
  if (version) {
    appendOutputLine(outputEl, t("env.versions.downloadHint"), "hint", gotoFromLink, "env");
  }
  // busy 态落在解释器 trigger（禁用 + label 文案，不用 setBusy 以免替换 innerHTML 销毁 interpLabelEl 引用）
  interpTriggerEl.disabled = true;
  interpLabelEl.textContent = t("env.state.creating");
  try {
    const r = await invoke<CreateVenvResult>("create_venv", { workspaceRoot: app.workspaceRoot, version });
    // 输出已流式（pip-stdout/stderr）推送，r.output 恒空，无需再 append
    // 直接以创建出的解释器路径持久化选中（不依赖 .venv 自动检测）
    if (r.python) {
      await invoke("set_interpreter", { workspaceRoot: app.workspaceRoot, path: r.python }).catch((e) => toastFail(t("env.fail.setInterpreter"), e));
    }
  } catch (e) {
    appendOutputLine(outputEl, t("env.createFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
    toastFail(t("env.action.createVenvBtn"), e);
    interpTriggerEl.disabled = false;
    syncInterpreterTrigger();
    return;
  }
  await refreshInterpreterStatus();
  // §4.6 引擎失效级联：新建 venv 并选中 = 环境层事实变化，必须重启引擎 + 作废快照
  await afterEnvChanged();
  await renderEnvPanel();
  interpTriggerEl.disabled = false;
  toast(t("env.created"), "success"); // §5.2 即时反馈
}

async function installPackage(): Promise<void> {
  const spec = envPkgInputEl.value.trim();
  if (!spec) return;
  if (!currentInterpreter) {
    // 回车/点按钮无反馈会让用户困惑（此前静默 return）；轻提示指路而非打断
    toastFail(t("env.fail.install"), t("env.noInterpreter"));
    return;
  }
  const btn = $btn("env-pkg-install");
  appendOutputLine(outputEl, `> uv pip install ${spec}  (${currentInterpreter})`, "cmd", gotoFromLink, "env");
  setBusy(btn, true, t("env.state.installing"));
  try {
    const code = await invoke<number>("pip_install", { workspaceRoot: app.workspaceRoot, interpreter: currentInterpreter, spec });
    if (code !== 0) {
      appendOutputLine(outputEl, t("env.installExitFailed", { code: code }), "stderr", gotoFromLink, "env");
      toastFail(t("env.fail.install"), `exit ${code}`);
    }
    // §4.6 引擎失效级联：装包改变环境层事实（失败 exit 也可能已装入部分包），
    // 重启刷新诊断 + 作废快照（防 30s 窗口内 prepareRun 复用装包前的缺失清单）
    await afterEnvChanged();
    if (code === 0) toast(t("env.installed", { spec: spec }), "success"); // §5.2 即时反馈（输出面板留详细记录）
  } catch (e) {
    appendOutputLine(outputEl, t("env.installFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
    toastFail(t("env.fail.install"), e);
  }
  envPkgInputEl.value = "";
  setBusy(btn, false);
  await renderPackages();
}

/** 卸载指定包（列表勾选批量卸载或单行卸载复用同一入口） */
async function uninstallPackages(names: string[]): Promise<void> {
  const list = names.filter(Boolean);
  if (list.length === 0 || !currentInterpreter) return;
  const proceed = await openConfirm({
    title: t("env.dialog.uninstallTitle"),
    message: t("env.uninstallMsg", { count: list.length, names: list.join("、") }),
    okLabel: t("env.action.uninstall"), cancelLabel: t("env.confirm.cancel"), kind: "danger",
  });
  if (!proceed) return;
  const btn = $btn("env-pkg-uninstall-selected");
  appendOutputLine(outputEl, `> uv pip uninstall ${list.join(" ")}  (${currentInterpreter})`, "cmd", gotoFromLink, "env");
  setBusy(btn, true, t("env.state.uninstalling"));
  try {
    const out = await invoke<string>("pip_uninstall", { interpreter: currentInterpreter, name: list.join(" ") });
    if (out) appendOutputLine(outputEl, out, "stdout", gotoFromLink, "env");
    // §4.6 引擎失效级联（审计扩展，v1.3 记录）：卸包后诊断应新增 missing-import，
    // 同样必须重启 + 作废快照
    await afterEnvChanged();
    toast(t("env.uninstalled", { count: list.length }), "success"); // §5.2 即时反馈
  } catch (e) {
    appendOutputLine(outputEl, t("env.uninstallFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
    toastFail(t("env.dialog.uninstallTitle"), e);
  }
  selectedPkgs.clear();
  setBusy(btn, false);
  await renderPackages();
}

async function uninstallSelectedPackages(): Promise<void> {
  await uninstallPackages([...selectedPkgs]);
}

/** 单个包升级（行内箭头） */
async function upgradePackage(name: string): Promise<void> {
  await upgradePackages([name]);
}

/** 升级全部过时包 */
async function upgradeAllPackages(): Promise<void> {
  if (!currentInterpreter || outdatedPackages.size === 0) return;
  const names = [...outdatedPackages.keys()];
  const proceed = await openConfirm({
    title: t("env.dialog.upgradeTitle"),
    message: t("env.upgradeMsg", { count: names.length }),
    okLabel: t("env.action.upgrade"), cancelLabel: t("env.confirm.cancel"), kind: "primary",
  });
  if (!proceed) return;
  await upgradePackages(names);
}

async function upgradePackages(names: string[]): Promise<void> {
  const list = names.filter(Boolean);
  if (list.length === 0 || !currentInterpreter) return;
  const btn = envPkgUpgradeAllBtn;
  appendOutputLine(outputEl, `> uv pip install --upgrade ${list.join(" ")}  (${currentInterpreter})`, "cmd", gotoFromLink, "env");
  setBusy(btn, true, t("env.state.upgrading"));
  try {
    const code = await invoke<number>("pip_upgrade", { interpreter: currentInterpreter, names: list });
    if (code !== 0) {
      appendOutputLine(outputEl, t("env.upgradeExitFailed", { code: code }), "stderr", gotoFromLink, "env");
      toastFail(t("env.dialog.upgradeTitle"), `exit ${code}`);
    }
    // §4.6 引擎失效级联：升级改变环境层事实（版本变化可能影响类型存根诊断），重启刷新 + 作废快照
    await afterEnvChanged();
    if (code === 0) toast(t("env.upgraded", { count: list.length }), "success"); // §5.2 即时反馈
  } catch (e) {
    appendOutputLine(outputEl, t("env.upgradeFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
    toastFail(t("env.dialog.upgradeTitle"), e);
  }
  setBusy(btn, false);
  await renderPackages();
}

// ---------- 灯泡「安装 X」/「加入 pyproject」（CodeAction 命令回调，§6.3 M3 升级） ----------

/**
 * 灯泡「安装 X」动作回调：优先走 dep diff 数据源（§6.3——dist 归一结果来自 dep_scan 的
 * packages_distributions 反查 + Rust DIST_ALIAS_FALLBACK 兜底；前端 PACKAGE_ALIASES 硬编码表
 * 已退役），经 runDepFix 统一编排（确认命令预览 / 互斥 / 流式输出 / 收尾协议 / toast）。
 * 快照缺席（体检未完成/刚作废）时回退旧 pip_install 单包快路径（行为 = M3 改造前基线）。
 */
export async function installMissingPackage(pkg: string): Promise<void> {
  if (!app.workspaceRoot) return;
  const module = (pkg ?? "").trim();
  if (!module) return;
  const diff = latestDiff();
  if (diff) {
    // diff 数据源：E1 命中 → dist 归一结果；未命中（刚敲的新 import，快照滞后）→ 按模块名安装。
    // M4-4：多候选（同 module 多 dist）→ 弹 openChoice 选择；单候选/null 沿旧路径。
    const hit = diff.missingInEnv.find((m) => m.module === module);
    let spec: string;
    if (hit && hit.distCandidates.length > 1) {
      const chosen = await resolveDistForInstall(module, hit.distCandidates);
      if (chosen === null) return; // 用户取消选择
      spec = chosen;
    } else {
      spec = hit?.dist ?? module;
    }
    await runDepFix(
      [{
        action: "install",
        dists: [spec],
        command: fixCommandPreview(diff, "install", [spec]),
        warning: hit && hit.dist === null ? NULL_DIST_WARNING : undefined,
      }],
      t("env.fail.install"),
    );
    return;
  }
  // 降级路径：无 diff 快照（旧 pip_install 直连，确认 + 流式 + afterEnvChanged 收尾）
  if (!currentInterpreter) {
    toast(t("env.autoInstallNoInterpreter"), "info");
    return;
  }
  const proceed = await openConfirm({
    title: t("env.fail.install"),
    message: `${t("env.installIntoPrefix", { module })}\n${currentInterpreter}\n\n${t("env.installConfirm")}`,
    okLabel: t("env.action.install"), cancelLabel: t("env.confirm.cancel"), kind: "primary",
  });
  if (!proceed) {
    // 用户主动取消不是错误：info 语义（原 stderr 红色渲染属语义错位）
    toast(t("env.installCanceled", { module: module }), "info");
    return;
  }
  appendOutputLine(outputEl, `> uv pip install ${module}  (${shortInterpreter(currentInterpreter)})`, "cmd", gotoFromLink, "env");
  try {
    const code = await invoke<number>("pip_install", { workspaceRoot: app.workspaceRoot, interpreter: currentInterpreter, spec: module });
    if (code === 0) {
      // 先 toast（装包已成功，用户不该盯着空反馈等数秒级收尾）；收尾失败单独提示
      toast(t("env.installedDiagnostics", { module: module }), "success");
      // 收尾（重算 diff + 重启引擎）失败不能落进下方 catch——那会误报「安装失败」，
      // 而包实际已装上；此处隔离为独立提示
      await afterEnvChanged().catch((e) => {
        console.warn("[env] 装包后刷新诊断失败:", e);
        toastFail(t("env.fail.refreshDiagnostics"), e);
      });
    } else {
      appendOutputLine(outputEl, t("env.installExitFailed", { code: code }), "stderr", gotoFromLink, "env");
      toastFail(t("env.fail.install"), `exit ${code}`);
    }
  } catch (e) {
    appendOutputLine(outputEl, t("env.installFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
    toastFail(t("env.fail.install"), e);
  }
}

/** 灯泡「安装 X 并加入 pyproject」回调（§6.3 E4/E3 → declare = uv add）：
 *  仅 pyproject 项目可执行（后端 plan_dep_fix 守卫，其余 style 返回明确错误）；
 *  确认/互斥/流式/收尾走 runDepFix 统一编排。 */
export async function declarePackage(spec: string): Promise<void> {
  const s = (spec ?? "").trim();
  if (!s || !app.workspaceRoot) return;
  const diff = latestDiff();
  const command = diff ? fixCommandPreview(diff, "declare", [s]) : `uv add ${s}`;
  await runDepFix([{ action: "declare", dists: [s], command }], t("env.action.declare"));
}

// ---------- 首启引导 ----------

/** 首次打开工作区时提示检测到的 .venv（§4.2 优先级） */
export async function maybePromptVenv(): Promise<void> {
  if (!app.workspaceRoot || venvPrompted.has(app.workspaceRoot)) return;
  venvPrompted.add(app.workspaceRoot);
  let pythons: PythonInfo[] = [];
  try {
    pythons = await invoke<PythonInfo[]>("list_pythons", { workspaceRoot: app.workspaceRoot });
  } catch {
    return;
  }
  // 空值防御：invoke「成功但返回 null」（mock 未覆盖 / 后端异常路径）会让 find 抛
  // TypeError 并炸掉 openWorkspace 后半段（曾致每个 E2E 用例 init 都带
  // "Cannot read properties of null (reading 'find')"，且会话恢复永不可达）。
  if (!Array.isArray(pythons)) return;
  const venv = pythons.find((p) => p.kind === "workspace-venv");
  // currentInterpreter 已由 openWorkspace 的 refreshInterpreterStatus 刷新（= get_interpreter 结果）。
  // get_interpreter 修复后：.venv 存在时 currentInterpreter 要么 === .venv（自动检测/显式选中），
  // 要么 === null（用户显式选了 uv run）——据此精准判断，尊重用户选择。
  if (venv) {
    // 已在用 .venv，或显式选了 uv run（.venv 存在却为 null）→ 都尊重现状，不劝改
    if (currentInterpreter === venv.path || currentInterpreter === null) return;
    // 选了其它解释器（系统 python 等）→ 建议切到工作区 .venv（非破坏性，primary 确认）
    if (await openConfirm({ message: t("env.venvDetected"), kind: "primary" })) {
      await invoke("set_interpreter", { workspaceRoot: app.workspaceRoot, path: venv.path }).catch((e) => toastFail(t("env.fail.setInterpreter"), e));
      await refreshInterpreterStatus();
    }
    return;
  }
  // 态A（#2 决策 4）：无 .venv 且无任何解释器 → 一次性 toast 引导创建（会话去重）。
  // 常驻横幅在面板内（renderNoEnvBanner）；toast 是面板未开时的触达渠道。
  if (!currentInterpreter && !noEnvPrompted.has(app.workspaceRoot)) {
    noEnvPrompted.add(app.workspaceRoot);
    toast(t("env.noEnvToast"), "info", {
      actionLabel: t("env.action.createVenvBtn"),
      onAction: () => void onCreateVenv(),
    });
  }
}

/** 首次启动环境引导（Phase 4 第 4 步）：探测 uv / 静态引擎，缺失则引导一键安装 */
export async function maybePromptToolchain(): Promise<void> {
  try {
    const engine = app.settings.lsp_engine ?? "pyrefly";
    const st = await toolchain.detectToolchain(engine);
    if (st.allOk) return;
    const missing: string[] = [];
    if (!st.uv) missing.push(t("env.tool.uv"));
    if (!st.engine.ok) missing.push(t("env.tool.engine", { name: st.engine.name }));
    const proceed = await openConfirm({
      title: t("env.dialog.bootstrapTitle"),
      message: `${t("env.bootstrapMissing")}\n\n${missing.map((m) => t("env.bootstrapBullet", { tool: m })).join("\n")}\n\n${t("env.bootstrapWhy")}\n\n${t("env.bootstrapAsk")}`,
      okLabel: t("env.action.installNow"),
      cancelLabel: t("env.action.later"),
      kind: "primary",
    });
    if (!proceed) return;
    // 展开底部输出面板，展示安装进度
    $("bottom").classList.remove("collapsed");
    appendOutputLine(outputEl, t("env.bootstrapEcho", { tools: missing.join("、") }), "cmd", gotoFromLink, "env");
    const ok = await toolchain.installToolchain(engine);
    appendOutputLine(
      outputEl,
      ok ? t("env.bootstrapOk") : t("env.bootstrapPartial"),
      ok ? "stdout" : "stderr",
      gotoFromLink,
      "env",
    );
  } catch (e) {
    console.warn("[toolchain] 探测失败，跳过引导:", e);
  }
}

// ---------- 接线 ----------

/** 环境面板 DOM 接线（main 的 init 调用）；restartEngine = startLsp（装完包重启引擎刷诊断） */
export function initEnvPanel(deps: { restartEngine: () => Promise<void> }): void {
  restartEngine = deps.restartEngine;
  // 语言切换时重绘持久文案：状态栏解释器 trigger（label/title 经 t() 现算）；
  // 面板/解释器下拉打开中则整体重绘，未打开时下次打开自然用新语言
  onLocaleChange(() => {
    syncInterpreterTrigger();
    if (!envModalEl.classList.contains("hidden")) void renderEnvPanel();
    if (interpOpen) renderInterpPopover();
  });

  // 环境面板（P25-T05）——状态栏解释器点击打开
  statusInterpreterEl.addEventListener("click", () => void openEnvPanel());
  // 状态栏芯片语义（第七批）：解释器芯片补了 role=button + tabindex，键盘 Enter/Space 亦可打开（对齐 engineChip）
  statusInterpreterEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void openEnvPanel();
    }
  });
  $btn("env-close").addEventListener("click", closeEnvPanel);
  $btn("env-pkg-install").addEventListener("click", installPackage);
  $btn("env-pkg-uninstall-selected").addEventListener("click", () => uninstallSelectedPackages());
  $btn("env-pkg-upgrade-all").addEventListener("click", () => upgradeAllPackages());
  // 自定义解释器下拉：trigger 开合 + 版本模态关闭（解释器项/动作行事件在渲染时绑定）
  interpTriggerEl.addEventListener("click", () => (interpOpen ? closeInterp() : openInterp()));
  $btn("venv-version-close").addEventListener("click", closeVersionModal);
  // 包筛选（即时过滤本地列表，不重新请求后端）
  envPkgFilterEl.addEventListener("input", () => {
    pkgFilter = envPkgFilterEl.value.trim();
    renderPkgLines();
  });
  // 回车安装（基础交互：此前必须点按钮）
  envPkgInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void installPackage();
    }
  });
  // §6.5 模态范式（memory 67600367）：移除「点遮罩关闭」——面板含装包输入等可编辑内容，
  // 误触遮罩会丢失未提交操作；关闭入口收敛为 X 按钮 + Esc（onEnvKeydown）
}

/** 环境域事件流接线：pip 与 toolchain 的流式输出（原 main init 内的四个 listen） */
export async function initEnvPanelEvents(): Promise<void> {
  // 包安装事件（流式输出，确认安装后由 pip_install 逐行推送）
  await getCurrentWindow().listen<{ data: string }>("pip-stdout", (e) => {
    for (const line of e.payload.data.split("\n")) if (line) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "env");
  });
  await getCurrentWindow().listen<{ data: string }>("pip-stderr", (e) => {
    for (const line of e.payload.data.split("\n")) if (line) appendOutputLine(outputEl, line, "stderr", gotoFromLink, "env");
  });
  // 工具链引导事件（Phase 4 第 4 步：uv/pyrefly 安装进度流式输出）
  await getCurrentWindow().listen<{ data: string }>("toolchain-stdout", (e) => {
    for (const line of e.payload.data.split("\n")) if (line) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "env");
  });
  await getCurrentWindow().listen<{ data: string }>("toolchain-stderr", (e) => {
    for (const line of e.payload.data.split("\n")) if (line) appendOutputLine(outputEl, line, "stderr", gotoFromLink, "env");
  });
}
