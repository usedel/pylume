// 运行域（TD-14 拆分；v3.4 M3：多实例运行模型 + 四控件运行组交互）。
// - runScript() / runProject()：统一运行控制台（PTY，真 TTY）；脚本 = 当前文件（全局唯一
//   「运行」tab，覆盖语义）；项目 = 项目入口（「项目」tab 复用 / 「项目 N」并行，§6.3/§6.4）。
// - 生命周期遵循 §7：实例与 tab 同生共死；preparing 所有出口统一收口（§7.5 硬规则 2）；
//   preparing 期关闭 tab 走 canceled 标记 + spawn 落地后按 id 幂等补杀（§7.4）。
// - 调试输出走输出面板（dap.rs 的 debug-stdout / debug-stderr 事件，§13.3），与运行通道分路。
// openFile / activateTab / renderTabs / saveActive 经 setRunFlowHandlers 注入
// （terminal.ts::setTerminalLinkHandler 的 handler 注入先例，避免与 main 循环依赖）。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { app, outputEl, type SaveOptions, type Tab } from "./state";
import { basename, errMsg, joinPath, parentDirOf } from "./util";
import { t } from "./i18n"; // 第五批 i18n：运行链路域动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { appendOutputLine } from "./output";
import { gotoFromLink } from "./tracebackLink";
import { openChoice, openConfirm } from "./dialog";
import { toast, toastFail } from "./toast";
import { openRunConfig } from "./runConfigPanel";
import { frameworkHintText, frameworkLabel, presetConfigured, type FrameworkPreset } from "./frameworks";
import * as kb from "./keybindings";
import * as dap from "./dap/client";
import {
  runScriptInTerminal, stopRunInstanceById, finalizeStoppedRunInstance, cancelRunInstance, setOutputPanelHooks,
  setRunTabClosedHook, setRunTabStopHook, setRunAbortProbe,
} from "./termUi";
import { currentInterpreter, shortInterpreter } from "./envPanel";
import {
  freshDiffForInterpreter, latestDiff, lazyHintLine, lazyMissingForFile,
  missingForFile, toWorkspaceRelative, uvRunSyncRisk,
} from "./depHealth";
import {
  EMPTY_RUN_CONFIG, addRunInstance, clearRunInstances, findRunInstance,
  latestActiveInstance, listRunInstances, normalizeRunConfig, projectRunActive,
  removeRunInstance, scriptRunActive,
  type RunConfig, type SelectionRunMeta,
} from "./runState";
import { startRunRecord, finishRunRecord, recordRunLines, runsSnapshot, type RunRecord } from "./runHistory";
import type { RunWidgetState } from "./runWidget";

// ---------- 注入（main 的 init 中 setRunFlowHandlers） ----------

interface RunFlowHandlers {
  openFile: (path: string, revealLine?: number) => Promise<void>;
  activateTab: (tab: Tab) => void;
  renderTabs: () => void;
  saveActive: (opts?: SaveOptions) => Promise<void>;
  /** 保存**指定** tab（运行目标可能不是活动 tab，只靠 saveActive 会漏存） */
  saveTab: (tab: Tab, opts?: SaveOptions) => Promise<void>;
}

let handlers: RunFlowHandlers | null = null;

export function setRunFlowHandlers(h: RunFlowHandlers): void {
  handlers = h;
}

function h(): RunFlowHandlers {
  if (!handlers) throw new Error("[Pylume] runFlow 尚未接线（setRunFlowHandlers 须在 init 中先于任何运行调用）");
  return handlers;
}

// ---------- 域内状态 ----------

/** CR-07：运行准备期闸门——检查与置位之间不得有 await，杜绝连按触发并发启动。
 * 多实例模型下按 kind 分闸（脚本 / 项目各自独立，§12：脚本与项目可同时进行）。 */
const runPreparingByKind: Record<"script" | "project", boolean> = { script: false, project: false };

function beginRunPreparing(kind: "script" | "project"): boolean {
  if (kind === "script" && scriptRunActive()) return false;
  if (runPreparingByKind[kind]) return false;
  runPreparingByKind[kind] = true;
  h().renderTabs(); // 准备期即置灰对应 ▶，给用户即时反馈
  return true;
}

function endRunPreparing(kind: "script" | "project"): void {
  runPreparingByKind[kind] = false;
  h().renderTabs();
}

function isPreparing(kind: "script" | "project"): boolean {
  return runPreparingByKind[kind];
}

/** 框架探针表（P1）：「生成运行配置」提示按「工作区 + 框架」每会话最多一次 */
const frameworkHintShown = new Set<string>();

/** 探测期防并发穿透（CR-07 同款纪律：同步检查并置位，await 期间二次进入直接放弃；
 *  释放后重入由 hintShown 键兜底去重，miss 场景重复探测无副作用） */
const frameworkProbeBusy = new Set<string>();

/** 提示去重键（工作区 + 框架：同一工作区可先后提示不同框架） */
function frameworkHintKey(root: string, framework: string): string {
  return `${root}#${framework}`;
}

/** §5.4：uv run 隐式同步风险提示按「工作区+状态」会话去重（venvPrompted 同款模式，§4.7 规则 2） */
const uvRunRiskHinted = new Set<string>();

/** M4-1：lazy 导入提示按「工作区+文件+内容」会话去重（每次运行同类提示只出一次） */
const lazyHinted = new Set<string>();

// ---------- 运行前公共准备 ----------

/** 运行前公共准备的产物 */
export interface RunPrep {
  /** 运行回显行：`> [venv] <解释器> <脚本> <args>  (<路径>)` */
  echo: string;
  /** 归一化后的完整运行配置 */
  profile: RunConfig;
}

/** 解释器来源前缀（回显行共用） */
function interpreterSource(): string {
  return currentInterpreter
    ? shortInterpreter(currentInterpreter) === ".venv"
      ? "venv"
      : "system"
    : "uv run";
}

/** 运行前公共准备：Python 文件校验 → 自动保存 → 依赖预检 → 读运行配置 → 组装回显。
 * 返回 null 表示不应运行（不是 Python 文件，或用户在预检对话框里选了取消）。
 * 运行与调试（main 的 runDebug）共用，避免「预检只在某条路径生效」这类漂移（§13.1）。 */
export async function prepareRun(path: string): Promise<RunPrep | null> {
  if (!path.endsWith(".py") && !path.endsWith(".pyw")) {
    toast(t("run.flow.notPython", { name: basename(path) }), "info");
    return null;
  }
  // 运行前强制保存**所有**脏 tab（PyCharm 式「运行/调试前保存」，与 autosave 开关无关——
  // 显式触发运行即隐式表达持久化意图）。autosave 语义：只写内容，不跑 ruff isort/format。
  // 旧实现只存运行目标 tab，会漏掉「脚本 import 的兄弟模块」——import 的还是磁盘旧内容。
  // 单个文件写盘失败 toast 提示但不中止运行（运行用磁盘内容，失败文件保持 dirty 由用户处置）。
  for (const tab of app.tabs) {
    if (tab.dirty && tab.kind !== "diff") {
      // 循环变量避开 t：t() 已是 i18n 取词函数（原变量名 t 与之撞名会遮蔽取词）
      await h().saveTab(tab, { runOnSaveActions: false }).catch((e) => toastFail(t("run.flow.saveBeforeRun", { name: basename(tab.path) }), e));
    }
  }
  // 运行前依赖预检（§5.4 升级：消费 dep diff 快照，检测真值唯一化 R1）：
  // 快照新鲜（<30s，R8）→ 直接用该文件的 E1 条目，避免运行前再 spawn 探针；
  // 过期/缺失 → 保留现有 check_missing_imports 单文件快路径（兜底不降级体验）。
  if (currentInterpreter) {
    const rel = toWorkspaceRelative(path, app.workspaceRoot);
    // 快照须「新鲜且扫描时解释器与当前一致」才可复用（v1.3 ⑫：切解释器后环境事实已变，
    // 旧快照的 missingInEnv 不可信）；不匹配自动回退单文件快路径
    const fresh = rel !== null ? freshDiffForInterpreter(currentInterpreter) : null;
    const missing = fresh && rel !== null
      ? missingForFile(fresh, rel)
      : await invoke<Array<{ name: string; line: number; stmt: string }>>(
          "check_missing_imports",
          { path, workspaceRoot: app.workspaceRoot },
        ).catch((e) => {
          console.warn("[pre-run] 依赖检测失败，跳过:", e);
          return [] as Array<{ name: string; line: number; stmt: string }>;
        });
    // M4-1 惰性导入「仅提示」：lazy 条目不阻塞（不出现在确认框），但运行前输出面板
    // hint 一行——纯 lazy 文件此前是「零感知直到运行报错」的盲区（会话去重防刷屏）。
    if (fresh && rel !== null) {
      const hint = lazyHintLine(lazyMissingForFile(fresh, rel));
      if (hint) {
        const key = `${app.workspaceRoot}|${rel}|${hint}`;
        if (!lazyHinted.has(key)) {
          lazyHinted.add(key);
          appendOutputLine(outputEl, hint, "hint", gotoFromLink);
        }
      }
    }
    if (missing.length > 0) {
      const lines = missing.map((m) => t("run.flow.precheckLine", { line: m.line, stmt: m.stmt })).join("\n");
      const proceed = await openConfirm({
        title: t("run.flow.precheckTitle"),
        message: `${t("run.flow.importsMissing", { lines })}\n\n${t("run.flow.confirmRun")}`,
        okLabel: t("run.flow.runAnyway"), cancelLabel: t("run.flow.cancel"), kind: "danger",
      });
      if (!proceed) return null;
    }
  } else {
    // uv run 兜底路径（§5.4）：lock 过期 / requirements 整体未装 / 声明依赖大量缺失时，
    // uv run 会按声明**隐式同步环境**（可能移除手动装的包）——反馈场景里最反直觉的坑，
    // 必须显性化。仅输出面板提示行不阻塞运行（预检本身无新 UI，§4.5）；快照略旧也可用
    //（提示性质非闸门），按工作区+状态会话去重防每次运行重复刷屏。
    const risk = uvRunSyncRisk(latestDiff());
    if (risk) {
      const key = `${app.workspaceRoot}|${risk}`;
      if (!uvRunRiskHinted.has(key)) {
        uvRunRiskHinted.add(key);
        appendOutputLine(outputEl, risk, "hint", gotoFromLink);
      }
    }
  }
  // 读取持久化的运行配置（后端同样读取并应用，此处用于运行前显式化回显）
  const rc = app.workspaceRoot
    ? await invoke<Partial<RunConfig>>("get_run_config", { workspaceRoot: app.workspaceRoot, scriptPath: path }).catch(() => ({} as Partial<RunConfig>))
    : ({} as Partial<RunConfig>);
  const args = rc.args?.trim() ?? "";
  const argsSuffix = args ? ` ${args}` : "";
  // P1（建议 2）：回显含来源前缀（[venv]/[system]/[uv run]）+ 实际解释器完整路径，
  // 让用户运行前明确知道“这次用哪套环境跑”。
  const source = interpreterSource();
  const cmd = currentInterpreter
    ? `${currentInterpreter} ${basename(path)}${argsSuffix}`
    : `uv run ${basename(path)}${argsSuffix}`;
  return { echo: `> [${source}] ${cmd}  (${path})`, profile: normalizeRunConfig(rc) };
}

// ---------- 生命周期收口（§7.5 硬规则：preparing 必定复位） ----------

/** preparing 的统一收口：spawn 成功 → running（写实例）；返回是否成功进入运行态。
 *  幂等护栏：实例已被移除（preparing 期关闭 tab）或已退出（stopRunById 先于 spawn 落地
 *  收口了 preparing 实例）时**不再复活为 running**——前者静默返回 false（补杀由 termUi 承担），
 *  后者保持 exited（进程若真已 spawn，killIfCanceled 已按 id 补杀，无孤儿）。
 *  调用方据返回值决定是否 startRunRecord（失败的收口不产生悬挂历史）。 */
function settleInstance(id: string, opts: {
  label: string;
  path: string | null;
  selection: SelectionRunMeta | null;
  startedAt: number;
}): boolean {
  const inst = findRunInstance(id);
  if (!inst || inst.phase === "exited") return false;
  inst.phase = "running";
  inst.label = opts.label;
  inst.path = opts.path;
  inst.selection = opts.selection;
  h().renderTabs(); // preparing→running 的 UI 刷新（⏹ 变亮、▶ 的 spinner 消退）——与 settleExited 对称
  return true;
}

/** 实例退出收口（自然退出 / 停止 / canceled 补杀共用）：phase=exited + 历史落档 +
 *  选区临时文件清理。tab 保留供回看（关闭 tab 时 removeRunInstance）。
 *  M4 实测修复：stopping=true（用户已发 \x03）时，即便 term-exit 带 code 也按
 *  stopped 落档——ConPTY 下 \x03 → CTRL_C_EXIT(0xC000013A) 几乎立即触发 term-exit，
 *  常先于 stopRunById 的宽限等待到达，「用户停止」不能被误记为自然退出。 */
function settleExited(id: string, reason: { kind: "code"; code: number } | { kind: "stopped" } | { kind: "canceled" }): void {
  const inst = findRunInstance(id);
  if (!inst || inst.phase === "exited") return; // 幂等（§7.5 硬规则 3）
  if (inst.selection) cleanupSelectionRunMeta(inst.selection);
  const wasStopping = inst.stopping;
  inst.phase = "exited";
  inst.stopping = false;
  const effective = reason.kind === "code" && wasStopping ? { kind: "stopped" as const } : reason;
  inst.exit = effective;
  finishRunRecord(id, effective.kind === "code" ? effective.code : null, effective.kind);
  h().renderTabs();
}

/** CR-05：清理选区运行临时文件与元信息（幂等；失败仅提示不阻断状态复位） */
function cleanupSelectionRunMeta(meta: SelectionRunMeta): void {
  invoke("delete_file", { path: meta.tempPath }).catch((e) => {
    appendOutputLine(outputEl, t("run.flow.cleanupFailed", { path: meta.tempPath, error: localizeBackendError(errMsg(e)) }), "hint", gotoFromLink);
  });
}

/** 工作区切换/关闭时的运行域整体复位（§15：停全部实例 + 清 tab 由 disposeTerminal 承担） */
export function resetRunSessionState(): void {
  clearRunInstances();
  runPreparingByKind.script = false;
  runPreparingByKind.project = false;
  frameworkHintShown.clear(); // 框架提示去重随工作区会话失效（同 §5.4 提示去重口径）
  uvRunRiskHinted.clear(); // §5.4 提示去重随工作区会话失效
  lazyHinted.clear();     // M4-1 lazy 提示去重同口径
}

/** 关闭工作区：框架提示去重均为工作区级，一并清空 */
export function clearRunProfilesCache(): void {
  frameworkHintShown.clear();
}

/** 运行进行中或准备中（调试互斥判定收窄为脚本运行，§13.2 裁决 10） */
export function isRunBusy(): boolean {
  return scriptRunActive() || runPreparingByKind.script;
}

// ---------- 运行组状态 ----------

/** 组装运行组状态（从实例列表 + app 派生，不新增第二份真值；§7.3 矩阵） */
export function runWidgetState(): RunWidgetState {
  const hasWs = !!app.workspaceRoot;
  const tab = app.activeTab;
  const isPy = !!tab && (tab.path.endsWith(".py") || tab.path.endsWith(".pyw"));
  // preparing 与 running 分开表达（Playwright 实测修复）：preparing → spinner 置灰；
  // running → ▶脚本置灰「已有脚本」/ ▶项目**可点**（触发二选一，§7.3）——
  // 此前 projectBusy 混含两态导致项目 running 时按钮永远停在「正在准备」
  const scriptPreparing = isPreparing("script");
  const projectPreparing = isPreparing("project");
  const scriptBusy = scriptRunActive() || scriptPreparing;
  const projectBusy = projectRunActive() || projectPreparing;
  // D4「调试态与运行态 UI 不混淆」：调试中 ⏹ 必须可用（点击路由到 debug_stop）
  const dbgPhase = dap.currentPhase();
  const debugging = dbgPhase === "starting" || dbgPhase === "running" || dbgPhase === "stopped";
  let scriptDisabledReason: string;
  if (!hasWs) scriptDisabledReason = t("run.flow.noWorkspace");
  else if (!tab) scriptDisabledReason = t("run.flow.noFile");
  else if (!isPy) scriptDisabledReason = t("run.flow.notPyFile");
  else if (scriptBusy) scriptDisabledReason = t("run.flow.scriptBusy");
  else scriptDisabledReason = "";
  // 调试中拒绝脚本运行（§13.2 互斥收窄：调试 ↔ 脚本运行互斥，项目放行）
  if (!scriptDisabledReason && debugging) scriptDisabledReason = t("run.flow.debugging");
  return {
    hasWs,
    canRunScript: hasWs && !!tab && isPy,
    scriptDisabledReason,
    // 项目运行只要求有工作区（入口探测不到时提示配置，不置灰，§7.3/§14）
    canRunProject: hasWs,
    projectDisabledReason: hasWs ? "" : t("run.flow.noWorkspace"),
    projectBusy,
    scriptBusy,
    // preparing 单独传递（spinner 只属于准备期；running 属于「可点弹二选一」）
    scriptPreparing,
    projectPreparing,
    debugging,
    runScriptShortcut: kb.bindingLabel("run_script"),
    runProjectShortcut: kb.bindingLabel("run_project"),
    stopShortcut: kb.bindingLabel("stop"),
    stopTarget: latestActiveInstance()?.label ?? null,
    canOpenConfig: hasWs,
  };
}

/** 停止指定实例（进程 + 实例态收口；幂等）。tab 停止按钮 / ⏹ / 停止并重跑共用。
 *  preparing 期（进程未落地）：标记 canceled，spawn 返回后由 killIfCanceled 补杀（§7.4）；
 *  running 期：Ctrl+C 软杀 → 宽限 → term_kill 强杀。发 \x03 前置位 stopping——
 *  term-exit 若先于宽限到达（ConPTY 下 CTRL_C_EXIT 立即触发），settleExited 按
 *  stopped 落档而非误记 code（M4 实测修复）。 */
export async function stopRunById(id: string): Promise<void> {
  const inst = findRunInstance(id);
  if (!inst || inst.phase === "exited") return; // 幂等（§7.5 硬规则 3）
  if (inst.phase === "preparing") {
    cancelRunInstance(id);
    settleExited(id, { kind: "canceled" });
    return;
  }
  inst.stopping = true;
  await stopRunInstanceById(id);
  settleExited(id, { kind: "stopped" });
}

/** 停止运行（⏹ / Ctrl+F2）：停最近启动且仍在跑的实例（只停一个，§10）；
 *  调试态下由 main 侧路由到 debug_stop（不进此函数）。 */
export async function stopRun(): Promise<void> {
  const target = latestActiveInstance();
  if (!target) return; // 幂等：都停了则无操作（§7.5 硬规则 3）
  await stopRunById(target.id);
}

/** 停止全部运行实例（§15 工作区切换/关闭：脚本 + 所有项目实例）。
 *  软杀宽限并行计时（Ctrl+C 广播 + 单一 1.2s 等待 → 集中强杀），避免 N 实例串行 N×1.2s。 */
export async function stopAllRuns(): Promise<void> {
  const targets = listRunInstances().filter((x) => x.phase !== "exited");
  if (targets.length === 0) return;
  await stopInstancesParallel(targets.map((x) => x.id));
}

/** 停止全部项目实例（二选一「停止并重跑」的前半段，§6.4 裁决 9） */
async function stopAllProjectInstances(): Promise<void> {
  const targets = listRunInstances().filter((x) => x.kind === "project");
  if (targets.length === 0) return;
  await stopInstancesParallel(targets.map((x) => x.id));
}

/** 并行停止一批实例：preparing 的标记 canceled；running 的先全部广播 Ctrl+C，
 *  共享一次宽限等待后集中强杀（多实例时不再各自等 1.2s）。
 *  P2-2（2026-09-29 review）：强杀阶段原实现逐个调 stopRunInstanceById——其内部对
 *  runActive 仍为 true 的实例会**再等一次 1.2s**（\x03 已广播过、宽限已给过），
 *  3 个未自行退出的长驻实例 = 关工作区时串行多卡 3.6s+，与注释宣称的并行语义相反。
 *  改为宽限后直接 term_kill + UI 收尾（软杀信号早已送达）。 */
async function stopInstancesParallel(ids: string[]): Promise<void> {
  const runningIds: string[] = [];
  for (const id of ids) {
    const inst = findRunInstance(id);
    if (!inst || inst.phase === "exited") continue;
    if (inst.phase === "preparing") {
      cancelRunInstance(id);
      settleExited(id, { kind: "canceled" });
    } else {
      inst.stopping = true; // \x03 先于收口到达时按 stopped 落档（同 stopRunById）
      await invoke("term_write", { id, data: "\x03" }).catch(() => undefined);
      runningIds.push(id);
    }
  }
  if (runningIds.length > 0) {
    await new Promise((r) => setTimeout(r, 1200));
    for (const id of runningIds) {
      // 幂等：已退出的（term-exit 先到）term_kill 由后端 no-op；UI 收尾照常
      await finalizeStoppedRunInstance(id);
      settleExited(id, { kind: "stopped" });
    }
  }
}

// ---------- 运行历史入档（重跑按记录原始形态路由） ----------

/** P2-M：历史「重跑」——按记录原始形态路由：项目记录重跑项目；文件记录激活 tab 后运行。 */
export async function rerunRecord(r: RunRecord): Promise<void> {
  if (r.kind === "project") {
    await runProject();
    return;
  }
  const tab = app.tabs.find((t) => t.path === r.path);
  if (tab) {
    h().activateTab(tab);
  } else {
    try {
      await h().openFile(r.path);
    } catch {
      toast(t("run.flow.rerunMissing", { name: basename(r.path) }), "error");
      return;
    }
  }
  await runScript(r.path);
}

// ---------- 运行脚本（§2：总是跑「当前文件」，无粘性目标） ----------

/** 启动一次脚本文件运行（统一运行控制台；脚本 = 全局唯一「运行」tab，覆盖语义 §6.3）。
 *  历史按实例入档（ANSI 剥离由 termUi 采集侧承担）。 */
async function launchScript(path: string, selection: SelectionRunMeta | null = null, probe?: boolean): Promise<void> {
  // v3.4 §6.4 脚本覆盖语义：脚本运行中再点「运行脚本」= 直接终止上一次并重跑（不弹框）。
  // 连点防护由 runPreparing 闸门承担（停止+重跑是原子的用户意图）。
  if (scriptRunActive() && !isPreparing("script")) {
    const old = listRunInstances().find((x) => x.kind === "script" && x.phase !== "exited")!;
    old.stopping = true; // \x03 先于宽限到达时按 stopped 落档（M4 实测修复）
    await stopRunInstanceById(old.id);
    settleExited(old.id, { kind: "stopped" });
  }
  if (!beginRunPreparing("script")) return; // CR-07：准备期闸门（同步检查并置位）
  let prep: RunPrep | null = null;
  try {
    prep = await prepareRun(path);
  } finally {
    if (!prep) endRunPreparing("script"); // 预检取消/失败 → 释放闸门
  }
  if (!prep) return;
  if (scriptRunActive()) {
    endRunPreparing("script"); // 准备期间已有脚本运行启动（退出事件重入）→ 放弃
    return;
  }
  const startedAt = Date.now();
  const label = selection ? t("run.flow.labelSelection", { name: basename(selection.sourcePath) }) : t("run.flow.labelScript", { name: basename(path) });
  // 同槽复用：上次运行已退出（exited 驻留，tab 保留回看）→ 旧实例先移除再登记新实例
  const prev = findRunInstance("run-term-script");
  if (prev) removeRunInstance("run-term-script");
  // 实例先登记为 preparing（启动前确保 tab 存在由 termUi 承担，§7.1 不变式）
  addRunInstance({
    id: "run-term-script",
    kind: "script",
    label,
    phase: "preparing",
    startedAt,
    path,
    selection,
    exit: null,
    canceled: false,
    stopping: false,
  });
  endRunPreparing("script"); // 实例登记后由实例态接管守卫（内含 renderTabs）

  try {
    await runScriptInTerminal({
      path,
      echo: prep.echo,
      kind: "script",
      probe,
      onData: (text) => recordRunLines("run-term-script", text),
      onExit: (code) => settleExited("run-term-script", { kind: "code", code }),
    });
    // preparing 期 tab 被关闭：runScriptInTerminal 内 killIfCanceled 已补杀，
    // termUi 侧回调已解绑，此处实例同步移除（§7.4 竞态兜底的 runState 半边）
    if (!settleInstance("run-term-script", { label, path, selection, startedAt })) return;
    startRunRecord("run-term-script", { kind: "script", path, label, selection });
  } catch (e) {
    // preparing 期 tab 被关闭（canceled）→ 实例已移除，幂等收尾
    if (!findRunInstance("run-term-script")) return;
    appendOutputLine(outputEl, t("run.flow.termRunFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink);
    toastFail(t("run.flow.run"), e);
    removeRunInstance("run-term-script");
    h().renderTabs();
  }
}

/** 运行当前打开的 .py/.pyw 文件（§2：▶ 运行脚本 / Ctrl+F10 / gutter ▶ / 标签右键 / 命令面板）。
 *  无工作区 / 非 Python 文件的拦截在 UI 层（置灰），此处兜底再拦一次。 */
export async function runScript(path?: string): Promise<void> {
  const target = path ?? app.activeTab?.path;
  if (!target) return;
  if (!app.workspaceRoot) {
    toast(t("run.flow.needWorkspace"), "info");
    return;
  }
  if (!target.endsWith(".py") && !target.endsWith(".pyw")) {
    toast(t("run.flow.notPython", { name: basename(target) }), "info");
    return;
  }
  await launchScript(target);
}

// ---------- 运行项目（§3：项目入口 = 模块名 | 入口脚本） ----------

/** 项目运行的回显行（与 prepareRun 同风格：来源前缀 + 命令 + cwd 说明） */
function projectEcho(p: RunConfig): string {
  const source = interpreterSource();
  const args = p.args?.trim() ? ` ${p.args.trim()}` : "";
  const cmd =
    p.entry.kind === "module"
      ? currentInterpreter
        ? `python -m ${p.entry.target}${args}`
        : `uv run python -m ${p.entry.target}${args}`
      : `${p.entry.target}${args}`;
  const cwd = p.cwd.trim() ? `  (cwd: ${p.cwd.trim()})` : "";
  return `> [${source}] ${cmd}${cwd}`;
}

/** 读取或探测项目配置；探测不到返回 null（调用方提示配置，§7.4 不静默失败） */
async function loadOrDetectProjectConfig(): Promise<RunConfig | null> {
  if (!app.workspaceRoot) return null;
  const stored = await invoke<Partial<RunConfig> | null>("get_project_run", { workspaceRoot: app.workspaceRoot })
    .then((raw) => (raw ? normalizeRunConfig(raw) : null))
    .catch(() => null);
  if (stored && stored.entry.target.trim()) return stored;
  // 首次运行：自动探测（命中即写入项目配置，用户可改）
  const detected = await invoke<{ source: string; summary: string; config: Partial<RunConfig> } | null>(
    "detect_project_entry",
    { workspaceRoot: app.workspaceRoot },
  ).catch(() => null);
  if (detected) {
    // 被动发现型信息：持久 hint（可回看），非易逝 toast
    appendOutputLine(outputEl, t("run.flow.entryDetected", { summary: detected.summary }), "hint", gotoFromLink);
    return normalizeRunConfig(detected.config);
  }
  return null;
}

/** 项目运行落到统一运行控制台（「项目」主 tab 或「项目 N」并行实例，§6.3/§6.4）。
 *  preparing 期 tab 被关闭（runScriptInTerminal 抛错或返回后 killIfCanceled 已补杀）→
 *  实例移除收尾（§7.4：不留孤儿、不卡 preparing）。 */
async function launchProject(p: RunConfig, instanceId: string, label: string, startedAt: number): Promise<void> {
  const prev = findRunInstance(instanceId);
  if (prev) removeRunInstance(instanceId); // 同槽复用（重启路径）：旧实例（已 exited）先移除
  addRunInstance({
    id: instanceId,
    kind: "project",
    label,
    phase: "preparing",
    startedAt,
    path: null,
    selection: null,
    exit: null,
    canceled: false,
    stopping: false,
  });
  const echo = projectEcho(p);
  try {
    await runScriptInTerminal({
      path: p.entry.target,
      echo,
      kind: "project",
      instanceId,
      onData: (text) => recordRunLines(instanceId, text),
      onExit: (code) => settleExited(instanceId, { kind: "code", code }),
    });
    // preparing 期 tab 被关闭：runScriptInTerminal 内 killIfCanceled 已补杀，实例同步移除
    if (!settleInstance(instanceId, { label, path: null, selection: null, startedAt })) return;
    startRunRecord(instanceId, { kind: "project", path: `project:${p.entry.target}`, label, selection: null });
  } catch (e) {
    if (!findRunInstance(instanceId)) return; // preparing 期 tab 被关闭 → 幂等收尾
    appendOutputLine(outputEl, t("run.flow.projectRunFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink);
    toastFail(t("run.flow.runProject"), e);
    removeRunInstance(instanceId);
    h().renderTabs();
  }
}

/** 运行项目（§3：▶ 运行项目 / Ctrl+Shift+F10 / 命令面板）。
 *  项目运行中再点 → 二选一对话框（§6.4）：停止并重跑（停**全部**项目实例）/
 *  新建实例（并行，「项目 N+1」tab，已有实例不动）；取消 = 安全退出。 */
export async function runProject(): Promise<void> {
  if (!app.workspaceRoot) return;
  if (isPreparing("project")) return; // 防双击（准备期内连点无效）
  // v3.4 §6.4：项目运行中再点「运行项目」= 二选一（裁决 9）；Esc / 取消安全退出
  let slot: "main" | "new" = "main";
  if (projectRunActive()) {
    const choice = await openChoice({
      title: t("run.flow.projectRunningTitle"),
      message: t("run.flow.projectRunningMsg"),
      okLabel: t("run.flow.stopAndRerun"),
      neutralLabel: t("run.flow.newInstance"),
      kind: "primary",
    });
    if (choice === "cancel") return;
    if (choice === "ok") {
      await stopAllProjectInstances();
      slot = "main"; // 裁决 9：停全部后复用「项目」主 tab，项目回到单实例状态
    } else {
      slot = "new"; // 并行：多开「项目 N+1」，已有实例不动
    }
  }
  if (!beginRunPreparing("project")) return;
  let p: RunConfig | null = null;
  try {
    p = await loadOrDetectProjectConfig();
  } finally {
    if (!p) endRunPreparing("project");
  }
  if (!p) {
    // G 类（toast + action）：一键直达配置面板，省掉「找菜单 → 切项目分区」两步
    toast(t("run.flow.noEntry"), "info", {
      actionLabel: t("run.flow.goConfigure"),
      onAction: () => void openRunConfig(),
    });
    return;
  }
  // 会话 id / tab 分配（§17-12）：复用「项目」主 tab 或新建「项目 N+1」
  const { instanceId, label } = allocateProjectSlot(slot);
  endRunPreparing("project");
  await launchProject(p, instanceId, label, Date.now());
}

/** 分配项目实例槽位：主 tab（run-term-project-1）或「项目 N+1」（并行，§6.4/§17-11）。
 *  会话 id 与 tab 由 termUi::runScriptInTerminal 统一管理，这里只决定「复用主 tab」还是
 *  「多开新实例」——重启路径固定主 tab；并行路径请求空闲序号。 */
function allocateProjectSlot(slot: "main" | "new"): { instanceId: string; label: string } {
  if (slot === "new") {
    const n = nextProjectSeq();
    return { instanceId: `run-term-project-${n}`, label: t("run.flow.projectN", { n: n }) };
  }
  return { instanceId: "run-term-project-1", label: t("run.flow.project") };
}

/** 项目实例序号分配：从 2 起找**第一个空闲**序号（exited 驻留的槽也占用——tab 还在），
 *  全部释放后回到最小值（标签不无限增长）。 */
function nextProjectSeq(): number {
  let n = 2;
  while (findRunInstance(`run-term-project-${n}`)) n++;
  return n;
}

// ---------- 框架探针表（P1：Django / Flask / FastAPI 预设 + 服务 URL 自动打开，§9/§16-4） ----------

/** 框架预设探测（探针表在 Rust：`docs/pycharm_framework_support_report.md` §8.2 P1）。
 *  每个「工作区 + 框架」每会话最多提示一次；**项目运行配置已等于该预设**则不打扰；
 *  工作区级「不再提示」由 Rust 侧 `framework_hints` 过滤（关闭后不再返回该框架）。
 *  探测与配置生成都只做「提示 + 用户点击」，绝不静默改配置/装包。 */
export async function maybeSuggestFramework(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || frameworkProbeBusy.has(root)) return;
  frameworkProbeBusy.add(root);
  try {
    await maybeSuggestFrameworkImpl(root);
  } finally {
    frameworkProbeBusy.delete(root);
  }
}

async function maybeSuggestFrameworkImpl(root: string): Promise<void> {
  const hit = await invoke<FrameworkPreset | null>("detect_framework", { workspaceRoot: root })
    .catch(() => null);
  if (!hit) return;
  const key = frameworkHintKey(root, hit.framework);
  if (frameworkHintShown.has(key)) return;
  frameworkHintShown.add(key);
  const projectRun = await invoke<Partial<RunConfig> | null>("get_project_run", { workspaceRoot: root })
    .catch(() => null);
  if (presetConfigured(projectRun, hit)) return;
  // 反馈通道复核（P2 全面核查修正）：框架探测是**被动发现**而非操作结果——持久 hint 行是对的
  // （用户可能稍后才注意到）；toast 4s 即逝，而去重键已标记本会话不再提示，错过 = 永久丢失入口。
  const el = appendOutputLine(outputEl, frameworkHintText(hit), "hint", gotoFromLink);

  const a = document.createElement("span");
  a.className = "out-link";
  a.textContent = t("run.flow.genConfigAndRun", { framework: frameworkLabel(hit) });
  a.addEventListener("click", () => {
    void createFrameworkProfile(hit).catch((e) => toastFail(t("run.flow.genConfig", { framework: frameworkLabel(hit) }), e));
  });
  el.appendChild(document.createTextNode("　"));
  el.appendChild(a);

  // 工作区级关闭开关（对齐 PyCharm「Languages & Frameworks | Flask」的抑制设计）：
  // 落在提示行内而非设置面板——发现的入口与关闭的入口同一处，一次交互完成。
  const off = document.createElement("span");
  off.className = "out-link";
  off.textContent = t("run.flow.dontAskAgain");
  off.addEventListener("click", () => {
    void (async () => {
      try {
        await invoke("set_framework_hint_disabled", {
          workspaceRoot: root,
          framework: hit.framework,
          disabled: true,
        });
        off.className = "";
        off.textContent = t("run.flow.hintOff");
        toast(t("run.flow.hintOffToast", { framework: frameworkLabel(hit) }), "success");
      } catch (e) {
        toastFail(t("run.flow.disableHint"), e);
      }
    })();
  });
  el.appendChild(document.createTextNode("　"));
  el.appendChild(off);
}

/** 一键生成框架预设并写入**项目配置**（v3.4 §9：预设命中即写入 project_run，用户可改）；
 *  写入后直接运行项目，服务 URL 由终端输出监听（Uvicorn / Django dev server / Werkzeug
 *  就绪行）自动用系统浏览器打开（§9，见 termUi 的 watchServiceUrlLine）。
 *  配置已等于预设 → 直接运行（幂等）；与预设不同 → 覆盖写入（用户点链接即已表达意图）。 */
async function createFrameworkProfile(hit: FrameworkPreset): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  const existing = await invoke<Partial<RunConfig> | null>("get_project_run", { workspaceRoot: root })
    .catch(() => null);
  if (presetConfigured(existing, hit)) {
    await runProject();
    return;
  }
  const profile: RunConfig = {
    ...EMPTY_RUN_CONFIG,
    entry: { kind: hit.entry.kind, target: hit.entry.target },
    args: hit.args,
    cwd: hit.cwd,
  };
  await invoke("set_project_run", { workspaceRoot: root, config: profile });
  toast(t("run.flow.projectConfigWritten", { summary: hit.summary }), "success");
  await runProject();
}

// ---------- 选区运行（§16-5：临时文件 → 脚本运行路径，probe=false） ----------

/** 运行选区（无选区时运行光标所在行）：写入源文件同目录的临时文件后按脚本运行路径走控制台
 *  （v3.4 §16-5：临时文件 → 终端执行，probe=false 片段不采样，结束清理临时文件；
 *  不改变运行目标——选区实例随脚本实例走，临时文件清理由 settleExited 统一承担）。 */
export async function runSelection(): Promise<void> {
  if (!app.activeTab || (scriptRunActive() && !isPreparing("script"))) return;
  const path = app.activeTab.path;
  if (!path.endsWith(".py") && !path.endsWith(".pyw")) {
    toast(t("run.flow.notPython", { name: basename(path) }), "info");
    return;
  }
  const editor = app.editor;
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;

  let code: string;
  let startLine: number;
  let endLine: number;
  if (sel.isEmpty()) {
    // 无选区 → 运行光标所在行
    startLine = sel.startLineNumber;
    endLine = sel.endLineNumber;
    code = model.getLineContent(startLine);
  } else {
    startLine = sel.startLineNumber;
    endLine = sel.endLineNumber;
    code = model.getValueInRange(sel);
  }
  if (!code.trim()) {
    toast(t("run.flow.emptySelection"), "info");
    return;
  }
  // CR-07：准备期闸门——保存 / 写临时文件都是 await，期间连点不得并发进入
  if (!beginRunPreparing("script")) return;
  try {
    if (app.activeTab.dirty) await h().saveActive({ runOnSaveActions: false }); // 运行前保存（不跑 ruff，与整文件运行同口径）

    // 临时文件写到源文件同目录：保证 import 相对导入 / 相对路径资源与源文件一致。
    // CR-05：文件名带进程内随机后缀——并发运行选区 / 跨目录源文件互不覆盖；
    // 结束后由 settleExited → cleanupSelectionRunMeta 删除；watcher 侧按前缀忽略。
    const tempPath = joinPath(
      parentDirOf(path),
      `__pylume_selection__${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.py`,
    );
    try {
      await invoke("write_file", { path: tempPath, content: code });
    } catch (e) {
      appendOutputLine(outputEl, t("run.flow.writeTempFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink);
      toastFail(t("run.flow.writeTemp"), e);
      return;
    }

    if (scriptRunActive()) {
      // 准备期间已有运行启动 → 放弃（闸门在 finally 释放）。
      // P2-3（2026-09-29 review）：临时文件必须清理——残留在源文件同目录会污染 git
      // 未跟踪列表 / depHealth 扫描 / quickOpen 清单。
      invoke("delete_file", { path: tempPath }).catch((e) => {
        appendOutputLine(outputEl, t("run.flow.cleanupFailed", { path: tempPath, error: localizeBackendError(errMsg(e)) }), "hint", gotoFromLink);
      });
      return;
    }

    // 选区运行用临时文件、**刻意不套运行配置**（含 args / env）：语义上是一次性片段。
    const startedAt = Date.now();
    const label = t("run.flow.labelSelection", { name: basename(path) });
    const selMeta = { tempPath, sourcePath: path, startLine };
    // 同槽复用：上次运行已退出（exited 驻留）→ 旧实例先移除再登记新实例
    const prev = findRunInstance("run-term-script");
    if (prev) removeRunInstance("run-term-script");
    addRunInstance({
      id: "run-term-script",
      kind: "script",
      label,
      phase: "preparing",
      startedAt,
      path: tempPath,
      selection: selMeta,
      exit: null,
      canceled: false,
      stopping: false,
    });
    h().renderTabs();
    const rangeLabel = startLine === endLine ? t("run.flow.lineSingle", { start: startLine }) : t("run.flow.lineRange", { start: startLine, end: endLine });
    const echo = t("run.flow.selEcho", { path: path, range: rangeLabel });
    try {
      // probe=false：选区是临时代码，不采样（避免污染项目 trace 库）
      await runScriptInTerminal({
        path: tempPath,
        echo,
        kind: "script",
        probe: false,
        onData: (text) => recordRunLines("run-term-script", text),
        onExit: (code2) => settleExited("run-term-script", { kind: "code", code: code2 }),
      });
      // preparing 期 tab 被关闭：补杀已由 termUi 完成，实例同步移除（§7.4）
      if (!settleInstance("run-term-script", { label, path: tempPath, selection: selMeta, startedAt })) return;
      startRunRecord("run-term-script", { kind: "script", path: tempPath, label, selection: selMeta });
    } catch (e) {
      appendOutputLine(outputEl, t("run.flow.runFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink);
      toastFail(t("run.flow.run"), e);
      // P2-3：失败路径同样清选区临时文件（成功路径由 settleExited/runTabClosedHook 负责）
      invoke("delete_file", { path: tempPath }).catch((e2) => {
        appendOutputLine(outputEl, t("run.flow.cleanupFailed", { path: tempPath, error: localizeBackendError(errMsg(e2)) }), "hint", gotoFromLink);
      });
      removeRunInstance("run-term-script");
      h().renderTabs();
    }
  } finally {
    // 无论是否进入运行态都释放闸门：成功路径实例态接管守卫，失败/放弃路径恢复可运行
    endRunPreparing("script");
  }
}

// ---------- 接线 ----------

/** 运行域 UI 接线（main 的 init 调用）。
 * v3.4 §17-3：输出面板钩子已无运行侧职责（转录器 / 输入行均删），
 * 保留空接线防 termUi 的 outputHooks 调用点空引用；
 * M3-3.2：注册运行 tab 关闭回调（§7.1 不变式的 runState 半边）。 */
export function wireRunFlow(): void {
  setOutputPanelHooks({
    onTabChange: () => {
      /* v3.4 §6.5：stdin 输入行已删，切标签无输入行可同步 */
    },
    onClear: () => {
      /* v3.4 §17-3：转录器已删，清空输出无未完结行状态需要丢弃 */
    },
  });
  setRunTabClosedHook((id) => {
    // 运行 tab 被关闭（closeTerminal 已先 term_kill）：实例移除 + 运行组重绘。
    // preparing 期：实例仍在档（spawn 在途）→ 移除 + 历史收尾（canceled），后续 spawn
    // 返回后由 killIfCanceled 补杀，runFlow 侧「settleInstance 返回 false」幂等收尾（§7.4）。
    // running 期：term_kill 即时生效，实例收口为 exited（历史在档记录 finish）。
    const inst = findRunInstance(id);
    if (inst) {
      if (inst.selection) cleanupSelectionRunMeta(inst.selection);
      finishRunRecord(id, null, inst.phase === "preparing" ? "canceled" : "stopped");
      removeRunInstance(id);
    }
    h().renderTabs();
  });
  setRunTabStopHook((id) => stopRunById(id));
  // §7.4 复查修复：spawn 前探针——实例已被 stopRunById（preparing 期）收口为 exited
  // 或被关闭 tab 私除时，放弃本次 spawn（堵「落地即孤儿」窗口；runState 是唯一真值）
  setRunAbortProbe((id) => {
    const inst = findRunInstance(id);
    return !inst || inst.phase === "exited";
  });
  // M3 验收测试钩子（Playwright + CDP 用；只读快照，不引入第二份真值）：
  // 返回运行实例列表 + 运行历史摘要。生产环境无消费者，保留在 wireRunFlow 便于
  // 与运行域同生命周期（工作区切换后实例表随之清空，快照永远反映当前态）。
  (window as unknown as { __ocProbe?: () => unknown }).__ocProbe = () => ({
    instances: listRunInstances().map((x) => ({ ...x })),
    history: runsSnapshot().map((r) => ({ ...r })),
  });
}

/** 调试事件接线（main 的 init 中 await）。v3.4 §13.3/§17-16：debuggee 输出走独立事件
 * debug-stdout / debug-stderr → 输出面板（运行角色的 run-* 事件已随 piped 路径下线，
 * 输出面板保留调试承载角色）。 */
export async function initRunEvents(): Promise<void> {
  await getCurrentWindow().listen<{ data: string }>("debug-stdout", (e) => {
    for (const line of splitLines(e.payload.data)) {
      appendOutputLine(outputEl, line, "stdout", gotoFromLink, "debug");
    }
  });
  await getCurrentWindow().listen<{ data: string }>("debug-stderr", (e) => {
    for (const line of splitLines(e.payload.data)) {
      appendOutputLine(outputEl, line, "stderr", gotoFromLink, "debug");
    }
  });
}

/** 按行拆分（调试输出按行转发；保留空行、末尾换行不产生空行） */
function splitLines(data: string): string[] {
  const segs = data.split("\n");
  if (segs.length > 0 && segs[segs.length - 1] === "") segs.pop();
  return segs;
}
