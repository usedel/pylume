// 问题面板（对标 PyCharm Problems / VS Code Problems 视图）+ 状态栏问题计数芯片。
//
// 背景（2026-09-29 保存错误排查后续）：15386 行大文件保存报 168 处错误，但错误散布全文件
// 且视口外的波浪线不可见——用户「看不到错哪了」。本域补齐两条可见性路径：
//   1. 状态栏芯片：当前文件 错误/警告 计数常驻（有错即亮，点击打开问题面板）；
//   2. 问题面板：底部「问题」标签，按文件分组列出全部打开文件的诊断，点击条目跳转定位。
//
// 数据源：Monaco marker（全 owner 桶统一覆盖——pylume-lsp / pylume-intel /
// pylume-ruff / pylume-pydantic / pylume-libs，与 saveTab / markerNavigation 同口径）。
// 刷新驱动：onDidChangeMarkers 订阅 + 500ms 防抖（pyrefly didOpen 首批与语义批相隔可达数秒，
// 且 ruffLint 保存后也各自刷 marker，防抖合并成一次渲染）。
//
// 跳转经 main.ts 注入的 openFile 回调（防反向依赖成环，findUsages::setOpenRefHandler 同范式）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, $ } from "./state";
import { basename, emptyState } from "./util";
import { t } from "./i18n"; // 第十一批 i18n：问题面板动态文案走语言包

/** 单条问题（渲染数据） */
interface ProblemItem {
  path: string;
  line: number;
  column: number;
  severity: number;
  message: string;
  source?: string;
}

/** 打开文件回调（main.ts 注入：openFile(path, line) + 聚焦编辑器） */
let onOpenProblem: ((path: string, line: number, column: number) => void) | null = null;
export function setOpenProblemHandler(fn: (path: string, line: number, column: number) => void): void {
  onOpenProblem = fn;
}

/** 显示面板回调（main.ts 注入 setBottomTab("problems")——本域不 import termUi，
 *  避免测试环境拉起 termUi→git→DOM 全链依赖） */
let onShowPanel: (() => void) | null = null;
export function setShowPanelHandler(fn: () => void): void {
  onShowPanel = fn;
}

/** marker 订阅句柄（工作区切换时释放；DisposableStore 纪律） */
let markersSubscription: MonacoApi.IDisposable | null = null;
/** 刷新防抖 timer（工作区切换时清除；防抖 timer 属工作区生命周期约定） */
let refreshTimer = 0;
/** 过滤态：all / error / warning */
let activeFilter: "all" | "error" | "warning" = "all";
/** 上次渲染指纹（过滤态 + 全部条目）：不变则跳过面板重建。
 *  背景（2026-09-29 实测 bug）：点击条目 → openFile → activateTab → lintActiveFile
 *  重设 ruff marker（值可未变，setModelMarkers 仍触发 onDidChangeMarkers）→ 防抖
 *  renderProblems 全量 replaceChildren → 滚动容器是**新建元素**，scrollTop 归零，
 *  表现为「点最后一条后过一会儿自动回到顶部」。指纹短路 + scrollTop 转移双保险。 */
let lastRenderFingerprint = "";

/** 滚动位置快照：最近一次**非零** scrollTop（渲染完成 + 用户滚动时更新）。
 *  不能在 go() 里现读——浏览器/自动化的 click 动作序列（scrollIntoViewIfNeeded / 焦点
 *  转移）会在 click 事件派发**前**把 scrollTop 原生归零（E-DX-PS9 实测：点击前 locator
 *  读 1190，go() 首行读 0）。只记非零：归零类 scroll（污染）不覆盖真实位置；代价是
 *  用户真滚回顶后点条目会被拉回上一个非零位（罕见场景，可接受）。 */
let lastNonZeroScrollTop = 0;

/** 条目列表 → 指纹（含过滤态；168 条量级毫秒级） */
function problemsFingerprint(items: ProblemItem[]): string {
  return `${activeFilter}\n${items
    .map((i) => `${i.path}|${i.line}|${i.column}|${i.severity}|${i.message}|${i.source ?? ""}`)
    .join("\n")}`;
}

/** 面板根元素 */
function panelEl(): HTMLElement {
  return $("problems-panel");
}

/** 状态栏芯片 */
function chipEl(): HTMLElement {
  return $("status-problems");
}

/** tab button（底部标签） */
function tabEl(): HTMLElement {
  return $("tab-problems");
}

/** 防抖刷新（500ms：合并同一轮 marker 批次） */
export function scheduleProblemsRefresh(): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => renderProblems(), 500);
}

/** marker → ProblemItem（全 owner；error+warning 两级）。
 *  排序：severity 降序（Error 在前）→ 行列升序——「全部」视图错误优先（PyCharm Problems
 *  同款），与 Monaco 渲染分层的取舍一致；分组渲染按此序遍历，error 文件自然排前。 */
function collectProblems(): ProblemItem[] {
  const S = app.monaco.MarkerSeverity;
  const out: ProblemItem[] = [];
  for (const tab of app.tabs) {
    if (tab.kind === "diff" || !tab.model) continue;
    const markers = app.monaco.editor.getModelMarkers({ resource: tab.model.uri }) as MonacoApi.editor.IMarker[];
    for (const m of markers) {
      if (m.severity !== S.Error && m.severity !== S.Warning) continue;
      out.push({
        path: tab.path,
        line: m.startLineNumber,
        column: m.startColumn,
        severity: m.severity,
        message: m.message,
        source: m.source,
      });
    }
  }
  out.sort((a, b) => b.severity - a.severity || a.line - b.line || a.column - b.column);
  return out;
}

/** 当前活动文件的问题计数（状态栏芯片数据） */
export function activeFileProblemCounts(): { errors: number; warnings: number } {
  const tab = app.activeTab;
  if (!tab || tab.kind === "diff" || !tab.model) return { errors: 0, warnings: 0 };
  const S = app.monaco.MarkerSeverity;
  let errors = 0;
  let warnings = 0;
  for (const m of app.monaco.editor.getModelMarkers({ resource: tab.model.uri }) as MonacoApi.editor.IMarker[]) {
    if (m.severity === S.Error) errors += 1;
    else if (m.severity === S.Warning) warnings += 1;
  }
  return { errors, warnings };
}

/** 状态栏芯片渲染（有错/警告才显示；error 红色警示态） */
export function renderProblemsChip(): void {
  const el = chipEl();
  const { errors, warnings } = activeFileProblemCounts();
  if (errors === 0 && warnings === 0) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.classList.toggle("has-errors", errors > 0);
  const parts: string[] = [];
  if (errors > 0) parts.push(`✕ ${errors}`);
  if (warnings > 0) parts.push(`⚠ ${warnings}`);
  el.textContent = parts.join("  ");
  el.setAttribute("data-tip", t("workbench.problems.statusTip", { errors: errors, warnings: warnings }));
}

/** 严重度徽标 */
function severityBadge(severity: number): { cls: string; label: string } {
  return severity === app.monaco.MarkerSeverity.Error
    ? { cls: "pb-sev-error", label: t("workbench.problems.sevError") }
    : { cls: "pb-sev-warning", label: t("workbench.problems.sevWarning") };
}

/** 单条问题行 */
function buildProblemLine(it: ProblemItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "pb-item";
  row.tabIndex = 0;
  row.setAttribute("role", "button");

  const sev = severityBadge(it.severity);
  const badge = document.createElement("span");
  badge.className = `pb-sev ${sev.cls}`;
  badge.textContent = sev.label;

  const lineNo = document.createElement("span");
  lineNo.className = "pb-line";
  lineNo.textContent = `${it.line}:${it.column}`;

  const msg = document.createElement("span");
  msg.className = "pb-msg";
  msg.textContent = it.message.split("\n")[0];
  msg.title = it.message;

  const src = document.createElement("span");
  src.className = "pb-src";
  src.textContent = it.source ?? "";

  row.append(badge, lineNo, msg, src);
  const go = (): void => {
    // savedTop 用滚动快照（见 lastNonZeroScrollTop 注释：click 动作序列会在事件派发前
    // 原生归零 scrollTop，handler 里现读必得 0）
    const savedTop = lastNonZeroScrollTop;
    onOpenProblem?.(it.path, it.line, it.column);
    // 跳转链（openFile → activateTab → reveal/focus/树跟随）还可能继续引发原生连带
    // 滚动。事件守卫 + 定时兜底双管：守卫拦截守卫窗口内的任意归零；50/600ms 定时兜底
    // 覆盖守卫挂载前后的窗口（仅当确实归零且面板可见时恢复，不覆盖用户主动滚动）。
    const restore = (): void => {
      const cur = panelEl().querySelector<HTMLElement>(".find-usages-results");
      if (cur && cur.scrollTop === 0 && savedTop > 0 && !panelEl().classList.contains("hidden")) {
        cur.scrollTop = savedTop;
      }
    };
    window.setTimeout(restore, 50);
    window.setTimeout(restore, 600);
    const scroller = panelEl().querySelector<HTMLElement>(".find-usages-results");
    if (scroller) {
      const guard = (): void => {
        if (scroller.scrollTop === 0 && savedTop > 0 && !panelEl().classList.contains("hidden")) {
          scroller.scrollTop = savedTop;
        }
      };
      scroller.addEventListener("scroll", guard);
      window.setTimeout(() => scroller.removeEventListener("scroll", guard), 2_000);
    }
  };
  row.addEventListener("click", go);
  row.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    // 阻止 Enter 的默认后续（keypress/激活合成）：go() 异步跳转中会把焦点交给编辑器，
    // Chromium 对 Enter 派发的 keypress 会落到新焦点（Monaco textarea）→ 被当"下一行"
    // 消费，光标从目标行跳到 +1 行（E-DX-PS10 实测：setPosition 1:1 两次后仍终值 2:1）
    e.preventDefault();
    go();
  });
  return row;
}

/** 文件分组头 */
function buildFileHeader(path: string, errors: number, warnings: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "search-file";
  const name = document.createElement("div");
  name.className = "search-file-name";
  const parts: string[] = [basename(path)];
  if (errors > 0) parts.push(`✕${errors}`);
  if (warnings > 0) parts.push(`⚠${warnings}`);
  name.textContent = parts.join("  ");
  name.title = path;
  el.appendChild(name);
  return el;
}

/** 过滤 chip */
function buildFilterChip(kind: "all" | "error" | "warning", label: string, count: number): HTMLElement {
  const b = document.createElement("button");
  b.className = "fu-chip" + (activeFilter === kind ? " active" : "");
  b.textContent = `${label} (${count})`;
  b.addEventListener("click", () => {
    activeFilter = kind;
    renderProblems();
  });
  return b;
}

/** 全量渲染（面板 + 状态栏芯片 + tab 徽标）。
 *  面板内容区带指纹短路与滚动保持：① 指纹（过滤态+条目）不变 → 不重建 DOM（点击条目
 *  跳转后 lintActiveFile 重设 ruff marker 触发的空刷新被吞掉，滚动位置自然不动）；
 *  ② 内容真变化（新诊断到达/修复消失）→ 重建后把 scrollTop 转移到新容器，用户正在
 *  浏览的视口不跳顶。芯片/徽标是轻量文本更新，不走指纹门控（活动文件切换即刷）。 */
export function renderProblems(): void {
  renderProblemsChip();
  const items = collectProblems();
  const S = app.monaco.MarkerSeverity;
  const errors = items.filter((i) => i.severity === S.Error).length;
  const warnings = items.filter((i) => i.severity === S.Warning).length;

  // tab 徽标（错误数随 tab 常驻，问题面板的可见性入口之一）
  const tab = tabEl();
  const badge = errors > 0 ? ` (${errors})` : "";
  const baseLabel = t("workbench.problems.baseLabel");
  tab.textContent = errors + warnings > 0 ? `${baseLabel}${badge}` : baseLabel;

  const panel = panelEl();
  // 指纹短路：条目与过滤态都没变 → 面板 DOM 不动（滚动/焦点/悬浮态全保留）
  const fp = problemsFingerprint(items);
  if (fp === lastRenderFingerprint && panel.dataset.rendered === "1") {
    return;
  }
  lastRenderFingerprint = fp;

  // 滚动位置转移：旧结果容器（若在）的 scrollTop 记下来，重建后写回新容器
  const prevScroller = panel.querySelector<HTMLElement>(".find-usages-results");
  const prevScrollTop = prevScroller?.scrollTop ?? 0;

  panel.textContent = "";

  if (items.length === 0) {
    // S4 空态教学（onboarding plan §3.4 缺口 1）：改用 emptyState 基建 + 下一步指引——
    // 诊断来自 ruff / 静态引擎 / 运行时 intel 三个桶，告诉用户「什么时候这里会有内容」。
    panel.appendChild(emptyState("check-all", t("workbench.problems.empty"), t("workbench.problems.emptyHint"), true));
    lastNonZeroScrollTop = 0;
    panel.dataset.rendered = "1";
    return;
  }

  // 工具栏（过滤 chips）
  const toolbar = document.createElement("div");
  toolbar.className = "find-usages-toolbar";
  toolbar.appendChild(buildFilterChip("all", t("workbench.problems.filterAll"), items.length));
  if (errors > 0) toolbar.appendChild(buildFilterChip("error", t("workbench.problems.sevError"), errors));
  if (warnings > 0) toolbar.appendChild(buildFilterChip("warning", t("workbench.problems.sevWarning"), warnings));
  panel.appendChild(toolbar);

  const filtered = activeFilter === "all"
    ? items
    : items.filter((i) => (activeFilter === "error" ? i.severity === S.Error : i.severity === S.Warning));

  // 按文件分组（文件内行升序）
  const results = document.createElement("div");
  results.className = "find-usages-results";
  const byFile = new Map<string, ProblemItem[]>();
  for (const it of filtered) {
    const arr = byFile.get(it.path) ?? [];
    arr.push(it);
    byFile.set(it.path, arr);
  }
  for (const [path, list] of byFile) {
    const errs = list.filter((i) => i.severity === S.Error).length;
    const warns = list.length - errs;
    results.appendChild(buildFileHeader(path, errs, warns));
    for (const it of list) results.appendChild(buildProblemLine(it));
  }
  panel.appendChild(results);
  // 滚动转移（新内容更短时 clamp 由浏览器按 scrollHeight 自动处理）
  if (prevScrollTop > 0) results.scrollTop = prevScrollTop;
  if (results.scrollTop > 0) lastNonZeroScrollTop = results.scrollTop;
  panel.dataset.rendered = "1";
}

/** 打开问题面板（刷新 + 显示；显示经注入回调，避免 termUi 依赖链） */
export function openProblemsPanel(): void {
  renderProblems(); // 立即刷新一次（防抖窗口内的最新状态）
  onShowPanel?.();
}

/** 接线：marker 订阅 + 状态栏芯片点击 + tab 点击。
 *  monaco 由 main.ts 注入后调用（一次性；订阅句柄入 DisposableStore 由 main 收口）。 */
export function wireProblemsPanel(): MonacoApi.IDisposable {
  const sub = app.monaco.editor.onDidChangeMarkers(() => {
    scheduleProblemsRefresh();
  });
  markersSubscription?.dispose();
  markersSubscription = sub;

  chipEl().addEventListener("click", () => openProblemsPanel());
  tabEl().addEventListener("click", () => {
    renderProblems();
    onShowPanel?.();
  });
  // 用户滚动 → 更新快照（go() 的 savedTop 数据源；容器随渲染重建，故挂在 panel 根用捕获
  // 阶段收 scroller 的 scroll——scroll 不冒泡但捕获可达；只记非零，归零类污染不覆盖）
  panelEl().addEventListener(
    "scroll",
    () => {
      const sc = panelEl().querySelector<HTMLElement>(".find-usages-results");
      if (sc && sc.scrollTop > 0) lastNonZeroScrollTop = sc.scrollTop;
    },
    true,
  );
  return sub;
}

/** 工作区切换清理（main.ts 的 resetWorkspaceUiState 调用）。
 *  指纹一并复位——面板 DOM 已被清空但指纹残留会导致下次渲染误短路（不重建空面板）。
 *  P1-3（2026-09-30 审计）：此前只清内存，面板 DOM / tab 徽标 / 状态栏芯片靠
 *  closeTabSilent → onDidChangeMarkers → 500ms 防抖间接兜底，存在短暂残留窗口
 *  （且若 marker 事件未触发则永久残留）。改为同步清理三处投影。 */
export function resetProblemsPanel(): void {
  window.clearTimeout(refreshTimer);
  activeFilter = "all";
  lastRenderFingerprint = "";
  lastNonZeroScrollTop = 0;
  const panel = document.getElementById("problems-panel");
  if (panel) {
    panel.textContent = "";
    delete panel.dataset.rendered;
  }
  // tab 徽标与状态栏芯片同步复位（collectProblems 已随 tab 全关而空，直接重渲染最省心）
  renderProblems();
}
