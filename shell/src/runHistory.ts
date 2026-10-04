// 运行历史（P2 · PyCharm Run 工具窗对标）：把每次运行的输出按**实例**留存，
// 可回看、可再点 traceback 跳转、可保存输出到文件（P2-O）。
//
// v3.4 M3-3.8（§17-8 + §11）：
// - **采集来源改为终端输出**：termUi 的 term-data 分发点挂钩（runOnData 回调），
//   剥离 ANSI（stripAnsi，termUi）后按行入档，失败降级原样入档（§19-6）；
// - **按实例绑定归属**：startRunRecord(instanceId, …)——脚本实例与「项目 N」实例
//   各写各的快照（记录 tab 标签 + 启动序号，§11 记录内容）；
// - 退出码取 term-exit 扩展的 code（§17-17 / M1-1.4）；
// - 控制台上方 chip 标签条已删（§6.5：与「运行 tab 复用」重复）——回看走
//   Ctrl+Shift+R 历史列表弹窗；上限 20 次（Pin 豁免）/ 单次 3000 行（保留尾部）。

import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { hideEl, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { app } from "./state";
import { basename, emptyState, errMsg, relativePath } from "./util";
import { onLocaleChange, t } from "./i18n"; // 第五批 i18n：运行历史域动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";

export interface RunLine {
  cls: string;
  text: string;
}

/** 一次运行的留存记录（按实例归属，§11） */
export interface RunRecord {
  id: number;
  /** 运行实例 id（`run-term-script` / `run-term-project-<N>`） */
  instanceId: string;
  /** 运行种类：脚本（含选区临时文件）/ 项目 */
  kind: "script" | "project";
  /** 被运行的脚本路径；项目运行为 `project:<入口>` */
  path: string;
  /** 实例 tab 标签（「运行 · main.py」/「项目」/「项目 2」，实例标识，§11） */
  label: string;
  /** 选区运行临时文件映射（null = 非选区运行） */
  selection: { tempPath: string; sourcePath: string; startLine: number } | null;
  startedAt: number;
  finishedAt: number | null;
  /** 退出码；运行被中断时为 null */
  code: number | null;
  /** 停止 / 取消标记（exit reason，§7.2） */
  exitKind: "code" | "stopped" | "canceled" | null;
  lines: RunLine[];
  /** Pin——豁免 MAX_RUNS 淘汰 */
  pinned: boolean;
}

export interface RunHistoryHandlers {
  clearOutput: () => void;
  appendLine: (cls: string, text: string) => void;
  /** 历史列表「重跑」按钮（main.ts 按记录路由：runProject / runScript） */
  rerun: (r: RunRecord) => void;
}

let handlers: RunHistoryHandlers | null = null;

export function setRunHistoryHandlers(h: RunHistoryHandlers): void {
  handlers = h;
}

// ---------- 存储 ----------

/** 留存次数上限（防长会话内存无界增长） */
const MAX_RUNS = 20;
/** 单次留存行数上限（超长输出只留尾部——报错总在最后） */
const MAX_LINES_PER_RUN = 3000;

const runs: RunRecord[] = [];
let nextId = 1;
/** 实例 id → 进行中的记录（多实例并行时各写各的快照，§11） */
const activeByInstance = new Map<string, RunRecord>();
/** 实例 id → 半行缓冲（term-data 按块到达，块尾无换行时是行中间；原 RunTranscript 的
 *  半行累积语义，§11「后台入档按 chunk 尽力切行」） */
const partialLineByInstance = new Map<string, string>();

/** 开始记录一次运行（runFlow 在实例 spawn 成功后调用；按实例归属） */
export function startRunRecord(
  instanceId: string,
  meta: { kind: "script" | "project"; path: string; label: string; selection: RunRecord["selection"] },
): void {
  // 同实例重跑：上一条记录若仍在档（未 finish）收尾为 stopped（旧进程已被停止/替换），
  // 半行缓冲一并冲刷——避免旧记录永久显示「运行中…」
  const prev = activeByInstance.get(instanceId);
  if (prev) {
    finishRunRecord(instanceId, null, "stopped");
  }
  partialLineByInstance.delete(instanceId);
  const rec: RunRecord = {
    id: nextId++,
    instanceId,
    kind: meta.kind,
    path: meta.path,
    label: meta.label,
    selection: meta.selection,
    startedAt: Date.now(),
    finishedAt: null,
    code: null,
    exitKind: null,
    lines: [],
    pinned: false,
  };
  runs.push(rec);
  activeByInstance.set(instanceId, rec);
  // 淘汰：从最旧找**已结束且未 Pin**的记录移除（Pinned 豁免；进行中 = finishedAt===null 不被移除）。
  // 判据必须用 finishedAt 而非 activeByInstance.has(instanceId)：instanceId 可复用（脚本恒
  // "run-term-script"），startRunRecord 时 activeByInstance 必含当前 instanceId，会让同
  // instanceId 的全部历史记录误判为「进行中」而永不淘汰（纯脚本场景内存无界增长）。
  while (runs.length > MAX_RUNS) {
    const idx = runs.findIndex((r) => !r.pinned && r.finishedAt !== null);
    if (idx < 0) break;
    runs.splice(idx, 1);
  }
}

/** 记录一段终端输出（termUi 的 term-data 分发 → runOnData；text 已剥离 ANSI）。
 *  半行缓冲：chunk 以换行结尾时清缓冲；否则末段留到下一 chunk 拼接（行界为近似值，
 *  回看场景可接受，§11）。 */
export function recordRunLines(instanceId: string, text: string): void {
  const rec = activeByInstance.get(instanceId);
  if (!rec || !text) return;
  const joined = (partialLineByInstance.get(instanceId) ?? "") + text;
  const segs = joined.split(/\r\n|\n|\r/);
  // 末段无换行结尾 → 留作半行缓冲（空串也占位，保证「行未终结」语义明确）
  partialLineByInstance.set(instanceId, segs.pop() ?? "");
  for (const l of segs) {
    if (l.length > 0) rec.lines.push({ cls: "stdout", text: l });
  }
  // 超限时保留尾部：脚本报错信息永远在最后，头部被截反而更可用
  if (rec.lines.length > MAX_LINES_PER_RUN) {
    rec.lines.splice(0, rec.lines.length - MAX_LINES_PER_RUN);
  }
}

/** 结束记录（term-exit 带 code / 停止 / canceled 补杀；幂等）——半行缓冲一并冲刷。 */
export function finishRunRecord(instanceId: string, code: number | null, exitKind: "code" | "stopped" | "canceled"): void {
  const rec = activeByInstance.get(instanceId);
  if (!rec) return;
  const partial = partialLineByInstance.get(instanceId) ?? "";
  if (partial) {
    rec.lines.push({ cls: "stdout", text: partial });
    if (rec.lines.length > MAX_LINES_PER_RUN) {
      rec.lines.splice(0, rec.lines.length - MAX_LINES_PER_RUN);
    }
  }
  partialLineByInstance.delete(instanceId);
  rec.finishedAt = Date.now();
  rec.code = code;
  rec.exitKind = exitKind;
  activeByInstance.delete(instanceId);
}

/** 全部历史（从新到旧） */
export function listRuns(): RunRecord[] {
  return [...runs].reverse();
}

/** 测试钩子快照（M3 验收 Playwright 用；只读，含未完结记录） */
export function runsSnapshot(): RunRecord[] {
  return [...runs].reverse();
}

/** 清掉某次记录 */
export function removeRun(id: number): void {
  const i = runs.findIndex((r) => r.id === id);
  if (i >= 0) runs.splice(i, 1);
}

/** 查看某次记录（历史列表点击 → 回填输出面板） */
export function viewRun(id: number): void {
  const r = runs.find((x) => x.id === id);
  if (!r) return;
  handlers?.clearOutput();
  for (const l of r.lines) handlers?.appendLine(l.cls, l.text);
}

/** 切换 Pin 状态（豁免淘汰；历史列表内操作） */
export function togglePin(id: number): void {
  const r = runs.find((x) => x.id === id);
  if (!r) return;
  r.pinned = !r.pinned;
}

/** 清空历史（工作区切换，§15） */
export function resetRunHistory(): void {
  runs.length = 0;
  activeByInstance.clear();
  partialLineByInstance.clear();
}

/** 展示名：脚本运行用文件名，项目运行用实例标签 */
function displayName(r: RunRecord): string {
  return r.kind === "project" ? r.label : basename(r.path);
}

/** P2-O：把指定记录的输出写入文本文件（对标 PyCharm Save console output to file）。
 *  M4 收口：保存动作随历史列表行走（每条记录一个保存按钮，保存「该条」）——
 *  原 #run-tabs-row 的「保存当前」按钮随 chip 条残留 DOM 一并删除。 */
export async function saveRunOutput(r: RunRecord): Promise<void> {
  if (!r) return;
  const stamp = new Date(r.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const path = await saveDialog({
    defaultPath: `${displayName(r)}-${stamp}.log`,
    filters: [{ name: t("run.hist.filterName"), extensions: ["log", "txt"] }],
  });
  if (!path) return;
  const content = r.lines.map((l) => l.text).join("\n") + "\n";
  try {
    await invoke("write_file", { path, content });
    handlers?.appendLine("hint", t("run.hist.savedOutput", { path: path }));
  } catch (e) {
    handlers?.appendLine("stderr", t("run.hist.saveOutputFailed", { error: localizeBackendError(errMsg(e)) }));
  }
}

// ---------- 历史列表弹窗（Ctrl+Shift+R：批量回看 / 键盘删除） ----------

let modalEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let sel = 0;

/** 时间 → HH:MM:SS */
function clockOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 状态摘要（退出码 / 行数 / 时长） */
function summaryOf(r: RunRecord): string {
  const dur = r.finishedAt ? `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s` : t("run.hist.running");
  const code = r.exitKind === "stopped" ? t("run.hist.exitStopped") : r.exitKind === "canceled" ? t("run.hist.exitCanceled") : r.code === null ? "—" : String(r.code);
  const pin = r.pinned ? t("run.hist.pinnedPrefix") : "";
  return t("run.hist.summary", { pin: pin, clock: clockOf(r.startedAt), lines: r.lines.length, dur: dur, code: code });
}

export function initRunHistory(): void {
  const host = document.getElementById("run-history-modal");
  if (!host) return;
  host.textContent = "";
  const card = document.createElement("div");
  card.className = "modal-card run-history-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", t("run.hist.title"));
  const list = document.createElement("div");
  list.id = "run-history-list";
  list.className = "run-history-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("run.hist.listAria"));
  card.appendChild(list);
  host.appendChild(card);
  modalEl = host;
  listEl = list;

  // 语言切换时重绘当前面板（与 git.ts 同款约定）；面板未打开时下次打开自然用新语言
  onLocaleChange(() => {
    if (isRunHistoryOpen()) renderList();
  });

  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".run-history-item");
    const id = row ? Number(row.dataset.id) : NaN;
    if (!Number.isNaN(id)) {
      viewRun(id);
      closeRunHistory();
    }
  });
  host.addEventListener("mousedown", (e) => {
    if (e.target === host) closeRunHistory();
  });
  document.addEventListener("keydown", (e) => {
    if (!isRunHistoryOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeRunHistory();
    } else if (e.key === "Delete") {
      const r = listRuns()[sel];
      if (r) {
        e.preventDefault();
        removeRun(r.id);
        sel = Math.max(0, sel - 1);
        renderList();
      }
    }
  });
}

export function isRunHistoryOpen(): boolean {
  return !!modalEl && !modalEl.classList.contains("hidden");
}

export function openRunHistory(): void {
  if (!modalEl) return;
  sel = 0;
  showEl(modalEl);
  releaseFocus?.();
  releaseFocus = trapFocus(modalEl);
  renderList();
}

export function closeRunHistory(): void {
  if (!modalEl) return;
  releaseFocus?.();
  releaseFocus = null;
  hideEl(modalEl);
}

function renderList(): void {
  const list = listEl;
  if (!list) return;
  list.textContent = "";
  const items = listRuns();
  if (items.length === 0) {
    list.appendChild(emptyState("debug-alt", t("run.hist.empty"), t("run.hist.emptyHint")));
    return;
  }
  items.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = `run-history-item${i === sel ? " active" : ""}`;
    row.dataset.id = String(r.id);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === sel));
    row.tabIndex = 0;

    const name = document.createElement("span");
    name.className = "run-history-name";
    name.textContent = displayName(r);
    const path = document.createElement("span");
    path.className = "run-history-path";
    path.textContent = app.workspaceRoot && r.kind === "script" && !r.path.startsWith("project:")
      ? relativePath(app.workspaceRoot, r.path)
      : displayName(r);
    path.title = r.path;
    const meta = document.createElement("span");
    meta.className = "run-history-meta";
    meta.textContent = summaryOf(r);
    row.append(name, path, meta);

    // Pin / 重跑 / 保存输出 / 删除（原 chip 条的三个动作 + P2-O 保存随 M4 收编进列表行）
    const pin = document.createElement("button");
    pin.className = `run-tab-btn run-tab-pin${r.pinned ? " pinned" : ""}`;
    pin.setAttribute("aria-label", r.pinned ? t("run.hist.unpin") : t("run.hist.pinAria"));
    pin.dataset.tip = r.pinned ? t("run.hist.unpin") : t("run.hist.pin");
    pin.innerHTML = '<i class="codicon codicon-pin" aria-hidden="true"></i>';
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(r.id);
      renderList();
    });

    const rerun = document.createElement("button");
    rerun.className = "run-tab-btn run-tab-rerun";
    rerun.setAttribute("aria-label", t("run.hist.rerun"));
    rerun.dataset.tip = t("run.hist.rerun");
    rerun.innerHTML = '<i class="codicon codicon-debug-restart" aria-hidden="true"></i>';
    rerun.addEventListener("click", (e) => {
      e.stopPropagation();
      closeRunHistory();
      handlers?.rerun(r);
    });

    // P2-O（M4 收口）：保存该条输出到文件（对标 PyCharm Save console output to file）
    const save = document.createElement("button");
    save.className = "run-tab-btn run-tab-save";
    save.setAttribute("aria-label", t("run.hist.saveAria"));
    save.dataset.tip = t("run.hist.save");
    save.innerHTML = '<i class="codicon codicon-save" aria-hidden="true"></i>';
    save.addEventListener("click", (e) => {
      e.stopPropagation();
      void saveRunOutput(r);
    });

    const close = document.createElement("button");
    close.className = "run-tab-btn run-tab-close";
    close.setAttribute("aria-label", t("run.hist.removeAria"));
    close.dataset.tip = t("run.hist.remove");
    close.innerHTML = '<i class="codicon codicon-close" aria-hidden="true"></i>';
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRun(r.id);
      renderList();
    });

    row.append(pin, rerun, save, close);

    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        viewRun(r.id);
        closeRunHistory();
      }
    });
    list.appendChild(row);
  });
}
