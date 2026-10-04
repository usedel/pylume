// 依赖健康域（dep health M1，docs/dep_health_dev_plan.md）：
// - DepDiff / DepStyle 契约类型（§3.3 v1：字段只增不删，消费方须容忍未知字段；camelCase 对齐 Rust serde）；
// - 打开工作区体检编排（§4.7：L0 dep_style 先行 / 弹窗排队轮询 / 令牌丢弃 / 摘要进输出面板——
//   M1 形态无横幅无弹窗，先让数据跑起来，横幅与面板是 M3）；
// - diff 快照管理（30s 新鲜度口径 §5.4/R8，供 prepareRun 与 M2 失效矩阵消费）。
// M2 扩展点：fs-changed 消费 / 终端完成摘要嗅探 / site-packages 级联都接到 rescan 入口。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { app, $, outputEl } from "./state";
import { appendOutputLine } from "./output";
import { gotoFromLink } from "./tracebackLink";
import { openChoice, openConfirm } from "./dialog";
import { toast, toastFail } from "./toast";
import { onLocaleChange, t } from "./i18n"; // 第七批 i18n：依赖健康域动态文案走语言包
import { errMsg } from "./util";
import { localizeBackendError } from "./i18n/backendError";

// ---------- 契约类型（§3.3，与 Rust DepDiff/DepStyle serde 序列化名一一对应） ----------

export type DepStyleKind = "pyproject" | "requirements" | "bare" | "external";

/** dep_style（L0 同步命令，零子进程）返回的轻量子集 */
export interface DepStyleInfo {
  style: DepStyleKind;
  /** style=external 时的管理器名（poetry/pipenv/pdm/conda），其余为 null */
  externalManager: string | null;
  /** style=requirements 时命中的主 requirements 文件（相对工作区根） */
  requirementsFile: string | null;
}

/** E1 代码 ⊄ 环境：缺失模块位点（按 module+file 聚合） */
export interface MissingModule {
  module: string;
  /** 发行版名（packages_distributions 反查 → 别名表兜底 → null；null 是正常占比，§3.3） */
  dist: string | null;
  /** 全部候选发行版名（M4-4 dist 歧义：len > 1 时安装动作弹候选选择）；字段只增不删 */
  distCandidates: string[];
  file: string;
  line: number;
  /** 全部位点皆在函数/方法体内（惰性导入）——仅提示不阻塞运行预检（M4） */
  lazy: boolean;
}

/** E2 声明 ⊄ 环境 */
export interface DeclaredMissing {
  dist: string;
  /** 原始版本约束串（如 ">=1.0,<2"），修复时原样交给 uv */
  spec: string;
}

/** v1.7 A：已声明未安装的代码引用（E1 分流产物，按 module 聚合） */
export interface DeclaredMissingModule {
  /** 顶层模块名（Python import 名） */
  module: string;
  /** 命中的声明 dist（归一化名） */
  dist: string;
  /** 所属声明组（"dev" / extras 名 / dependency-group 名 / "requirements" / "declared"） */
  group: string;
  /** 受影响文件数（聚合呈现） */
  files: number;
  /** 首个位点（跳转锚点） */
  file: string;
  line: number;
  /** 全部位点皆惰性导入（仅提示） */
  lazy: boolean;
}

/** E3 环境 ⊄ 声明（裸装漂移） */
export interface EnvDriftPkg {
  dist: string;
  version: string;
}

/** E4 代码 ⊄ 声明（pyproject 项目专用） */
export interface UndeclaredModule {
  module: string;
  dist: string | null;
  /** 全部候选发行版名（M4-4 dist 歧义）；字段只增不删 */
  distCandidates: string[];
  file: string;
  line: number;
}

/** DepDiff v1 契约（§3.3）：三层事实一致性 diff 的唯一真值，所有症状都是它的投影（R1） */
export interface DepDiff {
  style: DepStyleKind;
  externalManager: string | null;
  missingInEnv: MissingModule[];
  declaredMissing: DeclaredMissing[];
  /** v1.7 A：已声明未安装的代码引用（E1 分流）；字段只增不删 */
  declaredMissingModules: DeclaredMissingModule[];
  envDrift: EnvDriftPkg[];
  undeclared: UndeclaredModule[];
  /** E5：pyproject ↔ uv.lock 不一致（不依赖解释器——interpreter=null 时照常计算，v1.2 修订） */
  lockOutOfDate: boolean;
  /** style=requirements 且整个 requirements 声明集与环境快照零交集（E2 特例，横幅优先级 3 直接消费） */
  requirementsUninstalled: boolean;
  /** null = uv run 兜底（E1/E2/E3 环境侧置空；E4/E5 照常，UI 须显式呈现「环境侧检测不可用」） */
  interpreter: string | null;
  requirementsFile: string | null;
  /** epoch millis */
  scannedAt: number;
}

// ---------- 快照状态 ----------

/** 快照新鲜度窗口（§5.4/R8）：30s 内 prepareRun 直接复用，避免运行前再 spawn 探针 */
export const DIFF_FRESH_MS = 30_000;
/** §4.7 编排参数：体检延迟启动 / 弹窗在场时的轮询间隔 */
export const OPEN_CHECK_DELAY_MS = 1_500;
export const MODAL_POLL_MS = 500;

let lastDiff: DepDiff | null = null;
/** 体检令牌：切换/关闭工作区与新一轮体检启动时作废在途结果（pkgToken 同款先例，§4.7 规则 4） */
let scanToken = 0;

// ---------- M2 失效矩阵状态（§4.4/§5.5） ----------

/** 环境快照条目（dep_env_snapshot 返回，与 Rust PackageInfo serde 名对齐） */
export interface EnvSnapshotEntry {
  name: string;
  version: string;
}

/** dep-fs-changed 事件负载（与 Rust watcher::DepFileEvent 对齐；other 后端已过滤不发） */
export interface DepFileEvent {
  path: string;
  kind: "py" | "declaration" | "other";
}

/** dep_scan 扫描范围（M4-2 增量路由，与 Rust ScanScope 一一对应）：
 *  full = 打开工作区/手动刷新/环境信号/修复收尾；code = .py 信号；declaration = 声明文件信号 */
export type DepScanScope = "full" | "code" | "declaration";

/** 上次环境快照基线（§5.5 L1 真值判定）；null = 尚无基线（首次环境信号视为有差异） */
let lastEnvSnapshot: EnvSnapshotEntry[] | null = null;
/** 引擎重启（main 注入 startLsp）：环境事实变化后刷新 pyrefly 诊断（§4.6/反馈 3-4，红线消失） */
let restartEngine: () => Promise<void> = () => Promise.resolve();

// ---------- M3 注入钩子（main 接线；depHealth 不反向依赖 UI 模块，解环同 restartEngine 先例） ----------

/** 打开健康面板（envPanel.openEnvPanel）：toast「查看」/ 状态栏体检图标的点击入口 */
let openHealthPanel: () => void = () => {};
/** 扫描生命周期 → depHealthPanel 的状态栏图标与面板重绘 */
let onScanStart: () => void = () => {};
let onScanComplete: (diff: DepDiff | null) => void = () => {};

/** L0 style 事实（runOpenWorkspaceCheck t0 即存）：横幅优先级 1/2（external/bare）
 *  不依赖全量体检即可渲染（§4.7 t0 形态）；diff 就绪后横幅以 diff.style 为准。 */
let lastStyleInfo: DepStyleInfo | null = null;

/** 横幅/toast 会话去重（§4.7 规则 2：venvPrompted 模式推广——同一工作区+状态哈希只提示一次；
 *  resetDepHealth 清空 = 换工作区重置） */
const notifyDedup = new Set<string>();
/** 代码/声明层变更 → 防抖全量重算（§4.5：.py 静默、声明静默，diff 变化才级联） */
let fsRescanTimer: ReturnType<typeof setTimeout> | undefined;
/** 环境信号 → 防抖 2s 后快照对比（§4.4：嗅探/site-packages 突发合并为一次真值判定） */
let envCheckTimer: ReturnType<typeof setTimeout> | undefined;
/** 终端嗅探跨块缓冲（PTY 分块可能截断完成行，同 uvicornTail 先例） */
let sniffTail = "";

/** 防抖窗口：代码/声明层重算 / 环境信号快照对比（§4.4 环境信号防抖 2s） */
export const FS_RESCAN_DEBOUNCE_MS = 1_000;
export const ENV_CHECK_DEBOUNCE_MS = 2_000;

/** 注入引擎重启器与 M3 UI 钩子（main 的 init 调用；解环同 envPanel 先例——
 *  depHealth 不 import envPanel/depHealthPanel，回调全部经此注入） */
export function initDepHealth(deps: {
  restartEngine: () => Promise<void>;
  openHealthPanel?: () => void;
  onScanStart?: () => void;
  onScanComplete?: (diff: DepDiff | null) => void;
}): void {
  restartEngine = deps.restartEngine;
  openHealthPanel = deps.openHealthPanel ?? (() => {});
  onScanStart = deps.onScanStart ?? (() => {});
  onScanComplete = deps.onScanComplete ?? (() => {});
}

export function latestDiff(): DepDiff | null {
  return lastDiff;
}

export function latestStyleInfo(): DepStyleInfo | null {
  return lastStyleInfo;
}

/** 重新拉取 L0 style 事实（生成 pyproject / 迁移后横幅与徽章即时翻转，不必等全量扫描） */
export async function refreshStyleInfo(): Promise<DepStyleInfo | null> {
  const root = app.workspaceRoot;
  if (!root) return null;
  try {
    lastStyleInfo = await invoke<DepStyleInfo>("dep_style", { workspaceRoot: root });
  } catch (e) {
    console.warn("[depHealth] dep_style 失败:", e);
  }
  return lastStyleInfo;
}

/** 快照是否新鲜（<30s）——prepareRun 复用判据（§5.4） */
export function diffIsFresh(now: number = Date.now()): boolean {
  return lastDiff !== null && now - lastDiff.scannedAt < DIFF_FRESH_MS;
}

/** §5.4 预检复用判据（v1.3 修订 ⑫）：快照新鲜 **且扫描时解释器与当前一致** 才可复用——
 *  解释器切换后环境事实已变，旧快照的 missingInEnv 不可信（如扫描时 interpreter=null
 *  按契约环境侧为空，切换后再复用会漏报）；不匹配返回 null，调用方回退单文件快路径。 */
export function freshDiffForInterpreter(interpreter: string | null): DepDiff | null {
  if (lastDiff === null || !diffIsFresh()) return null;
  return lastDiff.interpreter === interpreter ? lastDiff : null;
}

/** 工作区切换/关闭时复位（main 的 resetWorkspaceUiState 调用）：作废在途体检 + 清快照 +
 *  清 M2 失效矩阵状态（环境基线 / 防抖定时器 / 嗅探缓冲），防旧工作区信号污染新面板 */
export function resetDepHealth(): void {
  scanToken++;
  lastDiff = null;
  lastEnvSnapshot = null;
  lastStyleInfo = null;
  notifyDedup.clear();
  modNotFoundHinted.clear(); // M4-3：换工作区后同模块可再提示
  if (fsRescanTimer !== undefined) {
    clearTimeout(fsRescanTimer);
    fsRescanTimer = undefined;
  }
  if (envCheckTimer !== undefined) {
    clearTimeout(envCheckTimer);
    envCheckTimer = undefined;
  }
  sniffTail = "";
}

/** 带令牌校验的扫描内核：在途结果遇令牌变化（切工作区/新一轮体检）一律丢弃。
 *  落快照后广播 onScanComplete（M3：状态栏图标熄灭/驻留 + 面板打开时重绘）。
 *  scope（M4-2）："code"（.py 信号：L0+L2，环境侧复用快照缓存）/"declaration"（声明文件
 *  信号：L0+L1，代码层复用双缓存）/缺省 full（环境信号/手动刷新/打开工作区/修复收尾）。
 *  注意：非 full 扫描落快照前先确保已有快照（首扫必 full）——非 full 结果的环境侧或
 *  代码侧是缓存重组，不与旧快照合并（后端已保证各层完整性），直接覆盖。 */
async function scanWithToken(workspaceRoot: string, token: number, scope?: DepScanScope): Promise<DepDiff | null> {
  try {
    const diff = await invoke<DepDiff>("dep_scan", { workspaceRoot, scope: scope ?? "full" });
    if (token !== scanToken) return null;
    lastDiff = diff;
    onScanComplete(diff);
    return diff;
  } catch (e) {
    if (token === scanToken) {
      appendOutputLine(outputEl, t("dep.checkFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
      onScanComplete(null);
    }
    return null;
  }
}

/** 立即执行一次全量体检并落快照（手动刷新 / M2 级联重算复用此入口） */
export async function runDepScan(workspaceRoot: string): Promise<DepDiff | null> {
  return scanWithToken(workspaceRoot, scanToken);
}

// ---------- 运行前预检消费（§5.4，PR3：prepareRun 接 diff 快照） ----------

/** 绝对路径 → 工作区相对路径（正斜杠，diff 的 file 键口径）；不在工作区下返回 null。
 *  Windows 大小写不敏感（盘符/路径大小写在不同来源间不稳定）。 */
export function toWorkspaceRelative(path: string, workspaceRoot: string | null): string | null {
  if (!workspaceRoot) return null;
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/");
  if (p.toLowerCase() === root.toLowerCase()) return "";
  if (!p.toLowerCase().startsWith(root.toLowerCase() + "/")) return null;
  return p.slice(root.length + 1);
}

/** §5.4：diff 快照中某文件的 E1 条目 → 运行前预检对话框形态（{name, line, stmt}，
 *  与 check_missing_imports 返回同构，prepareRun 的确认框文案零改动复用）。
 *  lazy 条目不进预检阻塞——保持旧 MISSING_IMPORT_SCRIPT（函数体整棵跳过）的行为基线，
 *  「仅提示」的完整降级策略是 M4 精度项。stmt 为近似还原（快照只存顶层模块名）。 */
export function missingForFile(
  diff: DepDiff,
  relPath: string,
): Array<{ name: string; line: number; stmt: string }> {
  const target = relPath.toLowerCase();
  // v1.7 ⑤：已声明未装的缺失（declaredMissingModules）交给 E2 小节呈现，预检不二次打扰
  const declaredMod = new Set(diff.declaredMissingModules.map((m) => m.module.toLowerCase()));
  return diff.missingInEnv
    .filter((m) => !m.lazy && m.file.toLowerCase() === target && !declaredMod.has(m.module.toLowerCase()))
    .sort((a, b) => a.line - b.line)
    .map((m) => ({ name: m.module, line: m.line, stmt: `import ${m.module}` }));
}

/** M4-1 惰性导入「仅提示」：某文件的 lazy 缺失条目（不阻塞预检，运行前输出面板 hint 一行）。
 *  纯 lazy 文件是「用户零感知直到运行报 ModuleNotFoundError」的盲区——此函数供
 *  prepareRun 组装提示行（会话去重由调用方承担）。v1.7 ⑤：已声明缺失不重复提示（归 E2 小节）。 */
export function lazyMissingForFile(
  diff: DepDiff,
  relPath: string,
): Array<{ name: string; line: number }> {
  const target = relPath.toLowerCase();
  const declaredMod = new Set(diff.declaredMissingModules.map((m) => m.module.toLowerCase()));
  return diff.missingInEnv
    .filter((m) => m.lazy && m.file.toLowerCase() === target && !declaredMod.has(m.module.toLowerCase()))
    .sort((a, b) => a.line - b.line)
    .map((m) => ({ name: m.module, line: m.line }));
}

/** M4-1：lazy 提示行文案（「N 个惰性导入未安装（不阻塞运行）：a L3、b L20」） */
export function lazyHintLine(items: Array<{ name: string; line: number }>): string | null {
  if (items.length === 0) return null;
  const detail = items.map((m) => `${m.name} L${m.line}`).join("、");
  return t("dep.lazyMissing", { count: items.length, detail: detail });
}

/** §5.4：uv run 兜底路径的隐式同步风险提示判据。「uv run 将按 lock 隐式同步环境，
 *  可能移除您手动安装的包」是反馈场景里最反直觉的坑，必须显性化——触发条件：
 *  lock 过期（E5，兜底路径照常计算）/ requirements 整体未安装 / E2 严重（声明依赖大量缺失）。
 *  返回提示文案；无需提示返回 null。快照略旧也可用（提示性质，非运行闸门）。 */
export const E2_SEVERE_COUNT = 5;

export function uvRunSyncRisk(diff: DepDiff | null): string | null {
  if (!diff) return null;
  const reasons: string[] = [];
  if (diff.lockOutOfDate) reasons.push(t("dep.reason.lockOutdated"));
  if (diff.requirementsUninstalled) reasons.push(t("dep.reason.reqUninstalled"));
  if (diff.declaredMissing.length >= E2_SEVERE_COUNT) {
    reasons.push(t("dep.reason.declaredMissing", { count: diff.declaredMissing.length }));
  }
  if (reasons.length === 0) return null;
  return t("dep.uvRunSyncRisk", { reasons: reasons.join("；") });
}

// ---------- 打开工作区体检编排（§4.7，M1 形态） ----------

/** 弹窗在前台判定：全部模态遵循 .modal.hidden 约定（index.html），一条选择器覆盖
 *  venv 确认 / 工具链引导 / 设置 / 环境面板等所有前台决策（R13 弹窗优先的判据） */
export function modalInForeground(): boolean {
  return document.querySelector(".modal:not(.hidden)") !== null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** style 徽章文案（摘要行与 M3 横幅共用口径） */
function styleLabel(style: DepStyleKind, externalManager: string | null): string {
  return externalManager ? `${style}(${externalManager})` : style;
}

/** 体检摘要行（M1：结果只进输出面板一行，无横幅无弹窗，§7 M1「先让数据跑起来」）。
 *  E 组计数 + 关键异常旗标 + 耗时——异常明细与修复入口是 M3 健康面板的事。 */
export function summarizeDiff(d: DepDiff, elapsedMs: number): string {
  const interp = d.interpreter ? t("dep.summary.interpOk") : t("dep.summary.interpMissing");
  const flags: string[] = [];
  if (d.lockOutOfDate) flags.push(t("dep.summary.flagLock"));
  if (d.requirementsUninstalled) flags.push(t("dep.summary.flagReq"));
  const flagStr = flags.length > 0 ? ` · ${flags.join(" · ")}` : "";
  return (
    t("dep.summary.head", { style: styleLabel(d.style, d.externalManager), interp: interp }) +
    t("dep.summary.e1e2", { missing: d.missingInEnv.length, declared: d.declaredMissing.length }) +
    (d.declaredMissingModules.length > 0 ? t("dep.summary.extra", { count: d.declaredMissingModules.length }) : "") +
    t("dep.summary.tail", { drift: d.envDrift.length, undeclared: d.undeclared.length, flags: flagStr, elapsed: elapsedMs })
  );
}

/** 打开工作区体检（§4.7 编排；main 的 openWorkspace 以 void 调用，绝不阻塞主流程）：
 *  t0      L0 dep_style 同步先行（零子进程；即使后续 L1/L2 失败，style 事实也已到手）；
 *  t0+1.5s 无弹窗 → dep_scan（L1 快照 + L2 探针在后端串行）；有弹窗 → 500ms 轮询排队（R13：
 *          用户决策优先于数据采集——venv 确认 / 工具链引导在场时绝不叠加第三弹窗）；
 *  落地    输出面板一行摘要 + 快照入位（prepareRun / M2 消费）。
 *  令牌语义：启动即 ++scanToken 作废上一轮在途结果；切换工作区由 resetDepHealth 作废本轮。 */
export async function runOpenWorkspaceCheck(workspaceRoot: string): Promise<void> {
  const token = ++scanToken;
  lastDiff = null;
  onScanStart(); // M3：状态栏体检图标转圈（§4.5「绝不弹窗」的唯一进度指示）
  try {
    // L0 先行（§4.7 t0）：bare/external 事实不依赖任何子进程
    let styleInfo: DepStyleInfo | null = null;
    try {
      styleInfo = await invoke<DepStyleInfo>("dep_style", { workspaceRoot });
      lastStyleInfo = styleInfo;
    } catch (e) {
      console.warn("[depHealth] dep_style 失败:", e);
    }
    if (token !== scanToken) return;

    // 弹窗优先（R13）：延迟启动 + 前台有模态则轮询等待
    await sleep(OPEN_CHECK_DELAY_MS);
    while (modalInForeground()) {
      if (token !== scanToken) return;
      await sleep(MODAL_POLL_MS);
    }
    if (token !== scanToken) return;

    // 已知边界（M1）：venv 确认弹窗刚关闭时 set_interpreter 可能仍在途（毫秒级窗口），
    // 极端情况下本次扫描读到旧解释器——M2 失效矩阵落地后由环境信号兜底重算。
    const t0 = Date.now();
    const diff = await scanWithToken(workspaceRoot, token);
    if (token !== scanToken) return;
    if (diff) {
      appendOutputLine(outputEl, summarizeDiff(diff, Date.now() - t0), "hint", gotoFromLink, "env");
      // M2：捕获环境快照基线，供后续环境信号做 L1 真值对比（§5.5）——避免首次终端装包
      // 因无基线被误判为「有差异」而多重启一次引擎。后台执行，不阻塞摘要落地。
      void captureEnvBaseline(workspaceRoot, token);
      // M3（§4.7 t0+~4s）：E 组异常 → toast +「查看」（横幅在面板内，面板未开时不可见，
      // toast 是异常的唯一触达渠道）；正常 → 仅状态栏图标熄灭（onScanComplete 已驱动）。
      notifyIssuesOnce(workspaceRoot, diff);
      return;
    }
    // 全量体检失败：至少留下 L0 事实行（不静默失败——反馈技术债决议，memory 61552154）
    const styleStr = styleInfo ? styleLabel(styleInfo.style, styleInfo.externalManager) : t("dep.style.unknown");
    appendOutputLine(outputEl, t("dep.summary.incomplete", { style: styleStr }), "hint", gotoFromLink, "env");
  } catch (e) {
    console.warn("[depHealth] 工作区体检异常:", e);
  }
}

// ---------- M2 失效矩阵（§4.4 三层失效信号 + §5.5 环境信号自愈序列） ----------

/** 捕获环境快照基线（打开工作区体检完成后调用）：带令牌校验，切工作区/新一轮体检则丢弃。
 *  失败静默——基线缺失时首次环境信号按「有差异」处理（多一次重算+重启，可接受）。 */
async function captureEnvBaseline(workspaceRoot: string, token: number): Promise<void> {
  try {
    const snap = await invoke<EnvSnapshotEntry[]>("dep_env_snapshot", { workspaceRoot });
    if (token === scanToken) lastEnvSnapshot = snap;
  } catch {
    /* 基线缺失不阻断——见调用点注释 */
  }
}

/** 环境快照真值对比（§5.5 步骤 1）：顺序无关的 name==version 集合相等判定。
 *  b=null（尚无基线）视为「有差异」——首次环境信号宁可多算一次不漏。 */
export function sameSnapshot(a: EnvSnapshotEntry[], b: EnvSnapshotEntry[] | null): boolean {
  if (b === null) return false;
  if (a.length !== b.length) return false;
  const ka = a.map((x) => `${x.name}==${x.version}`).sort();
  const kb = b.map((x) => `${x.name}==${x.version}`).sort();
  return ka.every((v, i) => v === kb[i]);
}

/** 环境信号统一入口（终端嗅探 / site-packages 监听共用）：防抖 2s 合并突发后做真值判定。
 *  §4.4：嗅探/监听只是**触发器**，真值以 uv pip list 快照对比为准（误报代价封顶为一次快照对比）。 */
export function scheduleEnvCheck(): void {
  if (envCheckTimer !== undefined) clearTimeout(envCheckTimer);
  envCheckTimer = setTimeout(() => {
    envCheckTimer = undefined;
    void handleEnvSignal();
  }, ENV_CHECK_DEBOUNCE_MS);
}

/** §5.5 固定收敛序列（不询问、不装包——环境侧被动感知永不自动写）：
 *  1. dep_env_snapshot 快照对比（L1 真值判定）；
 *  2. 有差异 → 重算 diff（L2）+ restartEngine 刷新诊断（§4.6/反馈 3-4：终端装包后红线消失）；
 *  3. 无差异 → 仅静默更新基线。
 *  M3 补充：有差异且 envDrift 非空 → toast +「查看」（健康面板 M3 才有落点，本阶段静默）。 */
async function handleEnvSignal(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  // 令牌守卫（对齐 runOpenWorkspaceCheck）：快照+重算约 1~3s，其间若切工作区/复位（resetDepHealth
  // 会 ++scanToken），在途结果一律丢弃——防为陈旧上下文写基线或重启引擎。
  const token = scanToken;
  let snap: EnvSnapshotEntry[];
  try {
    snap = await invoke<EnvSnapshotEntry[]>("dep_env_snapshot", { workspaceRoot: root });
  } catch (e) {
    // 快照失败（uv 缺失/超时）→ 不级联：检测是顾问不是路障（§4.5 通用红线）
    console.warn("[depHealth] 环境快照对比失败，跳过级联:", e);
    return;
  }
  if (token !== scanToken) return;
  if (sameSnapshot(snap, lastEnvSnapshot)) {
    lastEnvSnapshot = snap; // 无差异 → 静默更新基线（§5.5 步骤 3）
    return;
  }
  lastEnvSnapshot = snap;
  // 有差异（真值判定通过）→ 重算 diff + 重启引擎（环境层事实已变，§4.6 硬规则）
  const diff = await runDepScan(root);
  if (token !== scanToken) return;
  await restartEngine();
  // M3（v1.4 ⑥）：envDrift 非空 → toast 一次 +「查看」（§5.5 步骤 2；会话去重防反复打扰）
  if (diff) notifyEnvDriftOnce(root, diff);
}

/** 代码层/声明层失效信号消费（watcher 的 dep-fs-changed）：按信号类型分流扫描范围（M4-2）。
 *  - .py 变更 → scope="code"：L0+L2（AST mtime 增量 + resolution 缓存吸收成本，跳过环境快照/E5）；
 *  - 声明文件变更 → scope="declaration"：L0+L1（声明集重解析 + 环境重比，代码层复用双缓存）；
 *  - 混合突发（防抖窗口内既有 .py 又有声明）→ full（保守，宁多算不漏算）。
 *  重算不重启引擎（代码/声明编辑不改环境事实，pyrefly 自感知 .py）；首扫前（无快照）
 *  一律 full——非 full 的缓存重组依赖后端缓存已建立。 */
export function handleDepFsChanged(files: DepFileEvent[]): void {
  const hasPy = files.some((f) => f.kind === "py");
  const hasDecl = files.some((f) => f.kind === "declaration");
  if (!hasPy && !hasDecl) return;
  if (fsRescanTimer !== undefined) clearTimeout(fsRescanTimer);
  fsRescanTimer = setTimeout(() => {
    fsRescanTimer = undefined;
    const root = app.workspaceRoot;
    if (!root) return;
    const firstScan = lastDiff === null; // 非缓存依赖：lastDiff 存在 = 后端各层缓存已建立
    const scope: DepScanScope = firstScan || (hasPy && hasDecl)
      ? "full"
      : hasDecl
        ? "declaration"
        : "code";
    void scanWithToken(root, scanToken, scope);
  }, FS_RESCAN_DEBOUNCE_MS);
}

/** 终端完成摘要嗅探正则（§4.4，仅 uv 与 pip 的稳定完成标志——poetry/pdm 输出不稳定不装懂）。
 *  命令 echo（`uv pip install foo` / `pip install foo`）不含这些完成短语，天然不误触发（§9.2 误报控制）。 */
const PKG_DONE_RE =
  /(Installed \d+ packages?|Uninstalled \d+ packages?|Successfully installed|Successfully uninstalled)/;

/** 尾缓冲长度：完成短语最长 < 40 字符，留 64 足够兜底任意跨块截断（限长防大 chunk 拼接浪费） */
const SNIFF_TAIL_LEN = 64;

/** 终端输出嗅探（termUi 的 term-data 分发调用，text 须已剥 ANSI）：命中 uv/pip 完成摘要
 *  → scheduleEnvCheck（防抖 2s → 快照真值判定）。
 *  正确性：完成短语要么整段在本块、要么跨「上一块尾 | 本块头」——用 `sniffTail + text` 全窗口
 *  跑正则两者皆覆盖；尾缓冲限长 64 兜底跨块。
 *  性能：完成短语必含 "nstall"（Installed/Uninstalled/installed/uninstalled 的公共子串），
 *  先用 native `includes` 廉价预筛（远快于正则），无关块（服务日志等）跳过正则——繁忙终端每块省一次全文正则。 */
export function sniffTerminalOutput(text: string): void {
  const window = sniffTail + text;
  if (window.includes("nstall") && PKG_DONE_RE.test(window)) {
    sniffTail = "";
    scheduleEnvCheck();
    return;
  }
  sniffTail = window.slice(-SNIFF_TAIL_LEN);
}

// ---------- M4-3：traceback ModuleNotFoundError → 一键安装（§6.4 运行时兜底） ----------

/** traceback 的 ModuleNotFoundError 行（Python 3.x 稳定格式；模块名可含点，取顶层）。
 *  ImportWarning / UserWarning 等不匹配——只认真正缺席导致运行中断的场景。 */
const MOD_NOT_FOUND_RE = /ModuleNotFoundError:\s*No module named\s+'([A-Za-z_][A-Za-z0-9_.]*)'/;

/** 已提示过的模块（会话去重：同一模块反复报错只提示一次，防 toast 风暴——
 *  用户取消安装后脚本重跑同一错误属预期，不重复打扰；换工作区随 resetDepHealth 清空） */
const modNotFoundHinted = new Set<string>();

/** traceback ModuleNotFoundError 出口（§6.4 M4）：输出面板 / 终端分发点以**整行**喂入，
 *  命中 → toast +「安装 X」按钮（复用 E1 动作 install + 统一收尾协议）。
 *  与 sniffTerminalOutput 同挂 term-data 分发点（run 会话）；输出面板行渲染处另行接入。
 *  安装动作经注入的 installFn（默认 envPanel.installMissingPackage——M4 起内部走
 *  resolveDistForInstall 候选选择），解环同 restartEngine 先例。 */
let installMissingPkg: (module: string) => Promise<void> = () => Promise.resolve();

/** 注入安装动作（main 接线：envPanel.installMissingPackage） */
export function setDepInstallHandler(fn: (module: string) => Promise<void>): void {
  installMissingPkg = fn;
}

/** 单行检测入口（会话去重 + toast 触达）。返回 true = 命中（调用方可用于测试断言）。 */
export function handleTracebackLine(line: string): boolean {
  const m = MOD_NOT_FOUND_RE.exec(line);
  if (!m) return false;
  const module = m[1].split(".")[0];
  const key = `${app.workspaceRoot ?? ""}|${module}`;
  if (modNotFoundHinted.has(key)) return true;
  modNotFoundHinted.add(key);
  toast(t("dep.missingModuleToast", { module: module }), "error", {
    actionLabel: t("dep.action.install"),
    onAction: () => void installMissingPkg(module),
  });
  return true;
}

/** 接线 dep 域失效信号事件（main 的 init 调用）：watcher 的 dep-fs-changed / dep-env-changed。
 *  终端嗅探不经事件——termUi 的 term-data 分发直接调 sniffTerminalOutput（同 watchServiceUrlLine 先例）。 */
export async function wireDepHealthEvents(): Promise<void> {
  await getCurrentWindow().listen<DepFileEvent[]>("dep-fs-changed", (e) => handleDepFsChanged(e.payload));
  await getCurrentWindow().listen("dep-env-changed", () => scheduleEnvCheck());
}

// ---------- M3：异常触达 toast（§4.7 / §5.5 步骤 2，会话去重） ----------

/** 异常项总数（状态栏图标 / toast 的「N 项问题」口径）。requirementsUninstalled 不重复
 *  计数——其明细已逐条体现在 declaredMissing（E2）；仅声明集为空的边缘情形两者皆 0。 */
export function issueCount(d: DepDiff): number {
  return (
    d.missingInEnv.length +
    d.declaredMissing.length +
    d.declaredMissingModules.length +
    d.envDrift.length +
    d.undeclared.length +
    (d.lockOutOfDate ? 1 : 0)
  );
}

/** 打开工作区体检异常 → toast 一次 +「查看」（§4.7：横幅在面板内，toast 是面板未开时的触达渠道） */
function notifyIssuesOnce(root: string, diff: DepDiff): void {
  const n = issueCount(diff);
  if (n === 0) return;
  const key = `${root}|issues|${diff.style}|${n}|${diff.lockOutOfDate}|${diff.requirementsUninstalled}`;
  if (notifyDedup.has(key)) return;
  notifyDedup.add(key);
  toast(t("dep.foundIssues", { count: n }), "info", { actionLabel: t("dep.action.view"), onAction: () => openHealthPanel() });
}

/** §5.5 步骤 2（v1.4 ⑥ 归属 M3）：环境信号重算后 envDrift 非空 → toast 一次 +「查看」。
 *  由 handleEnvSignal 在重算完成后调用；去重键含漂移数——数字变化视为新状态可再提示。 */
export function notifyEnvDriftOnce(root: string, diff: DepDiff): void {
  if (diff.envDrift.length === 0) return;
  const key = `${root}|drift|${diff.envDrift.length}`;
  if (notifyDedup.has(key)) return;
  notifyDedup.add(key);
  toast(t("dep.envDriftToast", { count: diff.envDrift.length }), "info", {
    actionLabel: t("dep.action.view"),
    onAction: () => openHealthPanel(),
  });
}

// ---------- M3：修复动作编排（§5.1 矩阵 + §5.2 收尾协议 + §5.3 确认 + §5.6 L3 交互） ----------

/** dep_fix 动作集（与 Rust plan_dep_fix 的 action 枚举一一对应） */
export type DepFixAction = "install" | "sync" | "declare" | "lock" | "migrate";

/** 修复计划：一次 dep_fix 调用。批量 = 多 plan 一次确认、逐条执行、失败即停（§5.3） */
export interface DepFixPlan {
  action: DepFixAction;
  /** 包名/带 spec 的需求串（sync/lock/migrate 为空数组） */
  dists: string[];
  /** 确认弹窗预览的命令行（展示口径；实际参数由后端 plan_dep_fix 单点构建） */
  command: string;
  /** 影响面提示（§5.1 脚注 1：uv sync 会移除未声明包——确认弹窗须明示，不可仅以幂等带过） */
  warning?: string;
  /** 普通说明（非破坏性、不触发 danger 按钮）：如 E3 锁定已装版本的语义说明 */
  note?: string;
}

/** 忽略清单条目（与 Rust DepIgnoreEntry serde camelCase 对齐；edge = e1~e4） */
export interface DepIgnoreEntry {
  edge: string;
  key: string;
}

/** 命令预览（与后端 plan_dep_fix 的构建结果一致的展示口径） */
export function fixCommandPreview(diff: DepDiff, action: DepFixAction, dists: string[]): string {
  const reqFile = diff.requirementsFile ?? "requirements.txt";
  switch (action) {
    case "install":
      return diff.style === "pyproject" ? `uv add ${dists.join(" ")}` : `uv pip install ${dists.join(" ")}`;
    case "sync":
      return diff.style === "pyproject" ? "uv sync" : `uv pip install -r ${reqFile}`;
    case "declare":
      return `uv add ${dists.join(" ")}`;
    case "lock":
      return "uv lock";
    case "migrate":
      return `uv add -r ${reqFile}`;
  }
}

/** 确认弹窗命令预览折叠（§5.3 批量预览呈现口径）：dist 列表型命令（uv add /
 *  uv pip install …）包数过多时折叠中段为「…（其余 N 个）」，避免几十上百个漂移包
 *  把弹窗撑满一屏。完整命令仍以 plan.command 原样写进输出面板 `> command` 回显，
 *  审计信息不丢（memory 61552154：输出面板保留作详细记录）。 */
const PREVIEW_MAX_DISTS = 3;

export function previewFixCommand(plan: DepFixPlan): string {
  const n = plan.dists.length;
  if (n <= PREVIEW_MAX_DISTS) return plan.command;
  const tokens = plan.command.trim().split(/\s+/);
  // dist 列表恒为命令尾部连续 token（uv add <d1 … dn> / uv pip install <d1 … dn>）
  const head = tokens.slice(0, tokens.length - n).join(" ");
  const shown = tokens.slice(tokens.length - n, tokens.length - n + PREVIEW_MAX_DISTS).join(" ");
  const rest = n - PREVIEW_MAX_DISTS;
  return t("dep.listMore", { head: head, shown: shown, rest: rest });
}

/** E3 漂移包 → uv add 的版本约束 spec：锁定已装版本（`dist==version`），避免 uv add 解析
 *  最新版造成意外升级（用户明确要求）；version 为空（pip list 偶发无版本）时退化为裸 dist。 */
export function driftSpec(d: EnvDriftPkg): string {
  return d.version.trim() ? `${d.dist}==${d.version}` : d.dist;
}

/** 单条 uv 命令的 dist 分批上限（#1：防 93 个漂移包拼成一条 `uv add` 的「全有或全无」——
 *  任一版本 yank/解析失败整批作废；分批后失败只损失所在批，其余批照常写入）。
 *  20 个/批 ≈ 400 字符命令行，远低于 Windows CreateProcess 32767 上限。 */
export const DEP_FIX_BATCH_SIZE = 20;

/** 把 dist 列表型 plan 拆成多批子 plan（dist 列表恒为命令尾部连续 token，子批 command =
 *  原命令前缀 + 该批 dist；非 dist 型 sync/lock/migrate 的 dists 为空，原样返回）。 */
export function chunkPlan(plan: DepFixPlan, size: number): DepFixPlan[] {
  const n = plan.dists.length;
  if (n <= size) return [plan];
  const tokens = plan.command.trim().split(/\s+/);
  const head = tokens.slice(0, tokens.length - n).join(" ");
  const out: DepFixPlan[] = [];
  for (let i = 0; i < n; i += size) {
    const chunk = plan.dists.slice(i, i + size);
    out.push({ ...plan, dists: chunk, command: `${head} ${chunk.join(" ")}` });
  }
  return out;
}

/** dist=null 的降级提示（§3.3：反查不到发行版名是正常占比而非罕见兜底，按模块名安装须警示可能装错包）。
 *  i18n：导出绑定（ES live binding）——语言切换时在此重新取词，全部使用方无需感知。 */
export let NULL_DIST_WARNING = t("dep.warn.nullDist");
onLocaleChange(() => {
  NULL_DIST_WARNING = t("dep.warn.nullDist");
});

/** M4-4 dist 歧义选择器：同 module 多候选时弹 openChoice 选发行版。
 *  单候选/空候选直接返回（不弹窗）；两候选 = ok/neutral 双按钮（openChoice 形态上限）；
 *  超过两候选时列出全部、仅提供前两个快捷位，其余提示手动安装（>2 候选是极端场景）。
 *  返回 null = 用户取消或无可用候选。 */
export async function resolveDistForInstall(
  module: string,
  candidates: string[],
): Promise<string | null> {
  const cands = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0];
  const extra = cands.length > 2
    ? `\n\n${t("dep.otherCands", { cands: cands.slice(2).join("、") })}`
    : "";
  const choice = await openChoice({
    title: t("dep.dialog.distTitle"),
    // 确认语多段拼装（含 \n\n 不走 apply_ts 映射，避免语言包转义链失真），按段取词
    message:
      `${t("dep.distPickHeader", { module })}\n\n` +
      cands.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `${extra}\n\n${t("dep.distPickTail")}`,
    okLabel: t("dep.action.installDist", { dist: cands[0] }),
    neutralLabel: t("dep.action.installDist", { dist: cands[1] }),
    kind: "primary",
  });
  if (choice === "ok") return cands[0];
  if (choice === "neutral") return cands[1];
  return null; // 取消
}

// ---------- M3：灯泡数据源（§6.3，光标行匹配 diff 定案） ----------

/** 灯泡动作（client.ts 的 provideCodeActions 消费 → main 注册的命令 id 分发） */
export interface DepLineAction {
  /** install → INSTALL_PACKAGE_COMMAND；declare → DECLARE_PACKAGE_COMMAND */
  kind: "install" | "declare";
  module: string;
  /** 安装/声明 spec（diff 的 dist 归一结果优先——前端硬编码别名表退役，§6.3） */
  spec: string;
  title: string;
  warning?: string;
}

/** import 行解析（顶层模块名）：`import a.b` / `from a.b import x` → "a"。
 *  仅识别行首 import 语句——灯泡锚点是本行 import，不做全文件扫描（那是面板的职责）。 */
const IMPORT_LINE_RE = /^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/;

/** 光标行 → dep 动作（§6.3 升级 + 「光标行匹配 diff」定案）：
 *  - E1（该文件缺失模块）→「安装 X」——数据源从 marker 正则换成 diff（dist 归一在 dep_scan 完成）；
 *  - E4（已装未声明且本行 import）→「安装 X 并加入 pyproject」（uv add）；E3 漂移包被 import 时
 *    与 E4 是同一事实（装了+未声明+有 import 锚点），收敛为同一 declare 动作——纯未被 import 的
 *    漂移包无光标锚点，由健康面板行级动作提供（E3 灯泡形态的实施口径，记 §11 v1.5）；
 *  - E4/E3 无红色 marker（import 可解析），依赖 Monaco 光标移动时自动询问 provider 亮灯泡。 */
export function depActionsForLine(diff: DepDiff | null, relPath: string, lineText: string): DepLineAction[] {
  if (!diff) return [];
  const m = IMPORT_LINE_RE.exec(lineText);
  if (!m) return [];
  const module = m[1].split(".")[0];
  const file = relPath.toLowerCase();
  const out: DepLineAction[] = [];
  const miss = diff.missingInEnv.find((x) => x.module === module && x.file.toLowerCase() === file);
  if (miss) {
    out.push({
      kind: "install",
      module,
      spec: miss.dist ?? module,
      title: t("dep.dialog.installPkgTitle", { dist: miss.dist ?? module }),
      warning: miss.dist === null ? NULL_DIST_WARNING : undefined,
    });
  }
  const undecl = diff.undeclared.find((x) => x.module === module && x.file.toLowerCase() === file);
  if (undecl && diff.style === "pyproject") {
    out.push({
      kind: "declare",
      module,
      spec: undecl.dist ?? module,
      title: t("dep.dialog.installDeclareTitle", { dist: undecl.dist ?? module }),
      warning: undecl.dist === null ? NULL_DIST_WARNING : undefined,
    });
  }
  return out;
}

/** 批量计划的多候选提示（M4-4 复核修复 #3）：组级「全部修复」无法逐个弹选择器
 *  （openChoice 单实例模态），多候选模块按首候选执行——须在确认弹窗明示，用户知情。 */
function multiCandidateWarning(modules: string[]): string | undefined {
  if (modules.length === 0) return undefined;
  return t("dep.multiCandWarning", { modules: modules.join("、") });
}

/** 组级修复计划构建（§5.3 批量预览）：无内容 / 不可修（external 降级、非 pyproject 写声明）返回 null */
export function groupFixPlan(
  diff: DepDiff,
  edge: "e1" | "e2" | "e3" | "e4" | "e5" | "migrate",
): DepFixPlan | null {
  switch (edge) {
    case "e1": {
      if (diff.missingInEnv.length === 0) return null;
      const dists = [...new Set(diff.missingInEnv.map((m) => m.dist ?? m.module))];
      const warnings: string[] = [];
      if (diff.missingInEnv.some((m) => m.dist === null)) warnings.push(NULL_DIST_WARNING);
      const multi = multiCandidateWarning(
        diff.missingInEnv.filter((m) => m.distCandidates.length > 1).map((m) => m.module),
      );
      if (multi) warnings.push(multi);
      return {
        action: "install",
        dists,
        command: fixCommandPreview(diff, "install", dists),
        warning: warnings.length > 0 ? warnings.join("\n") : undefined,
      };
    }
    case "e2": {
      if (diff.declaredMissing.length === 0 && !diff.requirementsUninstalled) return null;
      return {
        action: "sync",
        dists: [],
        command: fixCommandPreview(diff, "sync", []),
        warning:
          diff.style === "pyproject"
            ? t("dep.plan.syncRemoves")
            : undefined,
      };
    }
    case "e3": {
      // 写声明仅 pyproject 可行；requirements/bare 的收敛路径是「迁移」（面板单独提供）
      if (diff.envDrift.length === 0 || diff.style !== "pyproject") return null;
      const dists = [...new Set(diff.envDrift.map((d) => driftSpec(d)))];
      // 锁定语义说明：仅当确有已装版本（dists 带 ==version）时提示；version 全空退化为裸 dist 时不误导
      const note = diff.envDrift.some((d) => d.version.trim())
        ? t("dep.plan.lockDeclare")
        : undefined;
      return { action: "declare", dists, command: fixCommandPreview(diff, "declare", dists), note };
    }
    case "e4": {
      if (diff.undeclared.length === 0) return null;
      const dists = [...new Set(diff.undeclared.map((u) => u.dist ?? u.module))];
      const warnings: string[] = [];
      if (diff.undeclared.some((u) => u.dist === null)) warnings.push(NULL_DIST_WARNING);
      const multi = multiCandidateWarning(
        diff.undeclared.filter((u) => u.distCandidates.length > 1).map((u) => u.module),
      );
      if (multi) warnings.push(multi);
      return {
        action: "declare",
        dists,
        command: fixCommandPreview(diff, "declare", dists),
        warning: warnings.length > 0 ? warnings.join("\n") : undefined,
      };
    }
    case "e5":
      return diff.lockOutOfDate ? { action: "lock", dists: [], command: "uv lock" } : null;
    case "migrate":
      // R4/R4.1：只读原文件、写 pyproject（缺 pyproject 时后端先生成最小模板）；原文件保留不动
      return diff.style === "requirements"
        ? {
            action: "migrate",
            dists: [],
            command: fixCommandPreview(diff, "migrate", []),
            warning: t("dep.plan.migrateWarning"),
          }
        : null;
  }
}

/** dep_fix 防重入（§5.6-3）：前端全局标志（面板所有修复按钮同步禁用）+ 后端会话互斥锁双保险 */
let fixInFlight = false;
export function depFixBusy(): boolean {
  return fixInFlight;
}

/** L3 修复执行（§5.6 交互规范 + §5.2 统一收尾协议）：
 *  ① 确认前置——openConfirm 列命令清单 + 影响面 + 「需联网」如实告知；有破坏性影响（uv sync）
 *     的确认走 danger 语义；
 *  ② 进度可见——展开底部输出面板（工具链引导先例），uv 输出经 pip-stdout/pip-stderr 流式滚动，
 *     不做假进度条；
 *  ③ 逐条执行、失败即停（§5.6-5：不继续后续命令，输出面板保留 exit code 全文，toastFail）；
 *  ④ 收尾三步必达（§5.2：重算 diff → restartEngine → toast）——失败路径也重算（半态环境如实呈现）。
 *  触发按钮的 setBusy 由 UI 层承担（本函数不感知按钮）。返回是否全部成功。 */
export async function runDepFix(plans: DepFixPlan[], title: string): Promise<boolean> {
  const root = app.workspaceRoot;
  if (!root || plans.length === 0) return false;
  if (fixInFlight) {
    toast(t("dep.busyToast"), "info");
    return false;
  }
  // #1 分批：dist 列表型 plan 拆成多批，防一条 `uv add` 93 个包「全有或全无」
  const batched = plans.flatMap((p) => chunkPlan(p, DEP_FIX_BATCH_SIZE));
  const lines = batched.map((p) => `    ${previewFixCommand(p)}`).join("\n");
  // 分批后同 plan 的 warning/note 会随子批重复——去重，确认弹窗只呈现一次
  const warns = [...new Set(batched.filter((p) => p.warning).map((p) => t("dep.warnPrefix", { warning: p.warning as string })))].join("\n");
  const notes = [...new Set(batched.filter((p) => p.note).map((p) => p.note as string))].join("\n");
  const proceed = await openConfirm({
    title,
    message:
      `${t("dep.confirmCmds")}\n\n${lines}\n\n` +
      `${notes ? notes + "\n\n" : ""}${warns ? warns + "\n\n" : ""}` +
      `${t("dep.confirmNet")}\n\n${t("dep.confirmAsk")}`,
    okLabel: t("dep.action.run"),
    cancelLabel: t("dep.confirm.cancel"),
    kind: batched.some((p) => p.warning) ? "danger" : "primary",
  });
  if (!proceed) return false;
  fixInFlight = true;
  $("bottom").classList.remove("collapsed"); // §5.6-2：输出面板是唯一的进度指示
  try {
    for (const p of batched) {
      appendOutputLine(outputEl, `> ${p.command}`, "cmd", gotoFromLink, "env");
      const code = await invoke<number>("dep_fix", { workspaceRoot: root, action: p.action, dists: p.dists });
      if (code !== 0) {
        appendOutputLine(outputEl, t("dep.fixExitFailed", { code: code }), "stderr", gotoFromLink, "env");
        toastFail(t("dep.fail.fix"), t("dep.cmdFailed", { code: code }));
        await settleAfterFix(root); // 半态环境由重算如实呈现（不掩盖，§5.6-5）
        return false;
      }
    }
    // §5.6-6：收尾原子执行——用户看到 toast 时诊断已刷新
    await settleAfterFix(root);
    toast(t("dep.fixDone"), "success");
    return true;
  } catch (e) {
    appendOutputLine(outputEl, t("dep.fixFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
    toastFail(t("dep.fail.fix"), e);
    await settleAfterFix(root);
    return false;
  } finally {
    fixInFlight = false;
  }
}

/** §5.2 统一收尾协议（三步必达）：重算 diff（验证收敛 + 更新快照，onScanComplete 联动 UI）
 *  → 刷新环境快照基线（防装包触发的 site-packages 信号再冗余级联一次，v1.4 ⑦）→ restartEngine。 */
async function settleAfterFix(root: string): Promise<void> {
  await runDepScan(root);
  await refreshEnvBaseline();
  await restartEngine();
}

/** 环境快照基线即时刷新（修复收尾 / 面板装包后调用；无工作区静默跳过） */
export async function refreshEnvBaseline(): Promise<void> {
  const root = app.workspaceRoot;
  if (root) await captureEnvBaseline(root, scanToken);
}
