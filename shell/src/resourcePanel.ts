// 资源可观测面板（A-1，PyCharm 调研）：状态栏「MEM」芯片 + 进程明细模态。
//
// 动机：PyCharm 最大的差评是「资源占用不可控且不可见」。我们的架构结构性更轻，
// 但「轻」必须可感知——芯片常驻显示外壳+子进程内存合计，面板打开时 2s 采样明细。
//
// M1 只观测（不 kill）：面板提供「重启 LSP 引擎」（经 handler 注入）与「刷新」。
// 采样纪律：芯片 30s 一次（空闲开销可忽略）；明细采样仅在本面板打开时进行，
// 关闭即停——可观测本身不能成为新的资源负担。

import { invoke } from "@tauri-apps/api/core";
import { lazyEl } from "./state";
import { showEl, hideEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { t } from "./i18n"; // 第十六批 i18n：资源面板摘要走语言包

export interface ProcInfo {
  pid: number;
  name: string;
  rssMb: number;
  cpu: number;
}

export interface ProcStats {
  shell: ProcInfo;
  children: ProcInfo[];
  totalMb: number;
}

export interface ResourcePanelHandlers {
  /** 重启静态语义引擎（main.ts 的 startLsp） */
  restartLsp: () => Promise<void>;
}

let handlers: ResourcePanelHandlers | null = null;

const chipEl = lazyEl("status-mem");
const modalEl = lazyEl("resource-modal");
const rowsEl = lazyEl("resource-rows");
const summaryEl = lazyEl("resource-summary");

let panelOpen = false;
let releaseTrap: (() => void) | null = null;
let sampleTimer: number | null = null;
let chipTimer: ReturnType<typeof setInterval> | null = null;

export function setResourcePanelHandlers(h: ResourcePanelHandlers): void {
  handlers = h;
}

function fmtCpu(cpu: number): string {
  return cpu > 0 ? `${cpu.toFixed(1)}%` : "—";
}

/** 渲染状态栏芯片：外壳 + 子进程合计内存 */
function renderChip(st: ProcStats): void {
  const el = chipEl as HTMLElement;
  el.textContent = `MEM ${Math.round(st.totalMb)} MB`;
  el.classList.remove("hidden");
}

function renderRows(st: ProcStats): void {
  const rows: ProcInfo[] = [st.shell, ...st.children];
  summaryEl.textContent = t("ide.res.summary", { mb: st.totalMb.toFixed(1), count: st.children.length });
  rowsEl.textContent = "";
  for (const p of rows) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = p.name;
    const pid = document.createElement("td");
    pid.textContent = String(p.pid);
    const mem = document.createElement("td");
    mem.textContent = `${p.rssMb.toFixed(1)} MB`;
    const cpu = document.createElement("td");
    cpu.textContent = fmtCpu(p.cpu);
    tr.append(name, pid, mem, cpu);
    rowsEl.appendChild(tr);
  }
}

async function sample(updateChip: boolean): Promise<void> {
  try {
    const st = await invoke<ProcStats>("proc_stats");
    renderRows(st);
    if (updateChip) renderChip(st);
  } catch {
    // 采样失败：隐藏芯片（不显示坏数据），面板内保留上次内容
    (chipEl as HTMLElement).classList.add("hidden");
  }
}

function schedulePanelSample(): void {
  if (!panelOpen) return;
  if (sampleTimer !== null) clearTimeout(sampleTimer);
  sampleTimer = window.setTimeout(() => {
    sampleTimer = null;
    void sample(false).then(schedulePanelSample);
  }, 2000);
}

function openPanel(): void {
  if (panelOpen) return;
  panelOpen = true;
  showEl(modalEl as HTMLElement);
  releaseTrap = trapFocus(modalEl as HTMLElement);
  (chipEl as HTMLElement).setAttribute("aria-expanded", "true");
  void sample(false).then(schedulePanelSample);
}

function closePanel(): void {
  if (!panelOpen) return;
  panelOpen = false;
  if (sampleTimer !== null) {
    clearTimeout(sampleTimer);
    sampleTimer = null;
  }
  releaseTrap?.();
  releaseTrap = null;
  hideEl(modalEl as HTMLElement);
  (chipEl as HTMLElement).setAttribute("aria-expanded", "false");
}

/** 接线（init 调用一次）：芯片点击/键盘 + 面板按钮 + 30s 芯片轻采样 */
export function wireResourcePanel(h: ResourcePanelHandlers): void {
  if (chipTimer !== null) return; // 防重复接线（幂等守卫；定时器为应用单例生命周期）
  handlers = h;
  const chip = chipEl as HTMLElement;
  chip.addEventListener("click", openPanel);
  chip.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter" || k === " ") {
      e.preventDefault();
      openPanel();
    }
  });
  lazyEl("resource-close").addEventListener("click", closePanel);
  lazyEl("resource-refresh").addEventListener("click", () => void sample(false));
  lazyEl("resource-restart-lsp").addEventListener("click", () => {
    void (async () => {
      await handlers?.restartLsp();
      await sample(false);
    })();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelOpen) closePanel();
  });
  // 首次 + 每 30s 轻采样（面板打开时由面板自身的 2s 采样接管，这里跳过避免双写）。
  // 采样定时器为应用单例生命周期（与面板同生共死，不随工作区切换重建）——
  // 此前有一个无人调用的 disposeResourcePanel 假清理函数，推送前复核时删除。
  chipTimer = setInterval(() => {
    if (!panelOpen) void sample(true);
  }, 30_000);
  void sample(true);
}
