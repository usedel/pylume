// 依赖健康面板（dep plan M3，§6.1/§6.2）：env-modal 内「依赖健康」分区的 UI 投影。
// 三视图（按断边/按文件/已忽略）+ 四级健康横幅 + 行级/组级修复动作 + 忽略管理 + 状态栏体检图标。
// 模块边界（§3.2）：diff 真值、修复编排（确认/互斥/收尾协议）、toast 会话去重都在 depHealth.ts；
// 本模块只做渲染与事件转发。openEnvPanel / 包列表刷新经 main 注入（envPanel 不反向依赖本模块，
// 本模块单向 import envPanel 的 shortInterpreter——无环）。
// 反馈技术债对齐（§6.5/memory 61552154）：即时操作结果一律 toast；文本全部 textContent 防注入。

import { invoke } from "@tauri-apps/api/core";
import { app, $, $btn, outputEl } from "./state";
import { codicon, setBusy, spinIcon } from "./util";
import { appendOutputLine } from "./output";
import { gotoFromLink } from "./tracebackLink";
import { openAlert } from "./dialog";
import { toast, toastFail } from "./toast";
import { onLocaleChange, t } from "./i18n"; // 第七批 i18n：依赖健康面板动态文案走语言包
import { errMsg } from "./util";
import { localizeBackendError } from "./i18n/backendError";
import { shortInterpreter } from "./envPanel";
import {
  NULL_DIST_WARNING, depFixBusy, driftSpec, fixCommandPreview, groupFixPlan, issueCount,
  latestDiff, latestStyleInfo, refreshStyleInfo, resolveDistForInstall, runDepFix, runDepScan,
  type DepDiff, type DepFixAction, type DepFixPlan, type DepIgnoreEntry, type DepStyleInfo,
} from "./depHealth";

// ---------- DOM 与视图状态 ----------

const bannerEl = $("dep-health-banner");
const bannerTextEl = $("dep-health-banner-text");
const bannerActionsEl = $("dep-health-banner-actions");
const styleBadgeEl = $("dep-style-badge");
const interpLabelEl = $("dep-interp-label");
const scannedAtEl = $("dep-scanned-at");
const refreshBtn = $btn("dep-refresh");
const contentEl = $("dep-health-content");
const statusEl = $("dep-health-status");
const envModalEl = $("env-modal");
const detailEl = $("dep-health-detail");
const collapseBtn = $btn("dep-collapse");

type DepTab = "edge" | "file" | "ignored";
type EdgeId = "e1" | "e2" | "e3" | "e4" | "e5";

const tabBtns: Record<DepTab, HTMLButtonElement> = {
  edge: $btn("dep-tab-edge"),
  file: $btn("dep-tab-file"),
  ignored: $btn("dep-tab-ignored"),
};

let currentTab: DepTab = "edge";
/** 依赖明细（三视图）折叠态：默认收起——环境面板首屏留给包管理主体，「有问题」信号
 *  由横幅与常驻头部承载；横幅「查看」/ 状态栏体检图标 / toast「查看」入口调 expandDepDetail 展开 */
let depDetailExpanded = false;
/** 大组自动折叠阈值（#3）：count 超过此值的 E 组默认收起——防 E3「93 项」全展开撑爆面板、
 *  把其它断边挤到需大量滚动；小组仍默认展开（异常是要行动的）。 */
const AUTO_COLLAPSE_COUNT = 15;
/** 分组开合的显式记录（用户点击 toggle 写入；无记录时按 count 阈值定默认），重渲染间保持。 */
const groupOpen = new Map<EdgeId, boolean>();

/** 分组是否展开：用户显式开合优先，否则大组（count > 阈值）默认折叠、小组默认展开（#3）。 */
function isGroupOpen(edge: EdgeId, count: number): boolean {
  const explicit = groupOpen.get(edge);
  if (explicit !== undefined) return explicit;
  return count <= AUTO_COLLAPSE_COUNT;
}
/** 注入：打开环境面板（状态栏图标 / toast「查看」入口）/ 修复后的包列表刷新 / 体检后仅重绘包行徽标 */
let openPanel: () => void = () => {};
let refreshPackages: () => void = () => {};
let repaintPackages: () => void = () => {};

// i18n：标签表为模块级缓存，语言切换时整体重建（使用方读属性发生在渲染期，见 onLocaleChange 刷新）
let EDGE_TITLES: Record<EdgeId, string> = {
  e1: t("dep.panel.edge.e1"),
  e2: t("dep.panel.edge.e2"),
  e3: t("dep.panel.edge.e3"),
  e4: t("dep.panel.edge.e4"),
  e5: t("dep.panel.edge.e5"),
};
let EDGE_LABELS: Record<string, string> = {
  e1: t("dep.panel.label.e1"), e2: t("dep.panel.label.e2"), e3: t("dep.panel.label.e3"), e4: t("dep.panel.label.e4"),
};
let FIX_TITLES: Record<string, string> = {
  e1: t("dep.panel.fix.e1"), e2: t("dep.panel.fix.e2"), e3: t("dep.panel.fix.e3"), e4: t("dep.panel.fix.e4"),
  e5: t("dep.panel.fix.e5"), migrate: t("dep.panel.fix.migrate"),
};
let NOT_READY_HINT = t("dep.panel.notReady");

// ---------- 初始化 / 复位 ----------

/** 明细折叠态同步：hidden 类与 aria-expanded 同一写入点切换（ARIA 状态单一写入点约定） */
function syncDepDetail(): void {
  detailEl.classList.toggle("hidden", !depDetailExpanded);
  collapseBtn.setAttribute("aria-expanded", String(depDetailExpanded));
}

/** 展开依赖明细（横幅「查看」/ 状态栏体检图标 / toast「查看」入口调用） */
export function expandDepDetail(): void {
  if (depDetailExpanded) return;
  depDetailExpanded = true;
  syncDepDetail();
}

/** 防重入守卫：本函数往单例 DOM 上挂事件监听与 onLocaleChange 订阅，重复 init 会叠加 */
let panelInitialized = false;

export function initDepHealthPanel(deps: {
  openEnvPanel: () => void;
  refreshPackagesIfOpen: () => void;
  repaintPackagesIfOpen: () => void;
}): void {
  if (panelInitialized) return;
  panelInitialized = true;
  openPanel = deps.openEnvPanel;
  refreshPackages = deps.refreshPackagesIfOpen;
  repaintPackages = deps.repaintPackagesIfOpen;
  // 语言切换：重建模块级标签缓存；健康横幅常驻（不随 env-modal 关闭隐藏）必须重绘，
  // 打开中的面板明细一并重绘，未打开部分下次渲染自然用新语言
  onLocaleChange(() => {
    EDGE_TITLES = { e1: t("dep.panel.edge.e1"), e2: t("dep.panel.edge.e2"), e3: t("dep.panel.edge.e3"), e4: t("dep.panel.edge.e4"), e5: t("dep.panel.edge.e5") };
    EDGE_LABELS = { e1: t("dep.panel.label.e1"), e2: t("dep.panel.label.e2"), e3: t("dep.panel.label.e3"), e4: t("dep.panel.label.e4") };
    FIX_TITLES = { e1: t("dep.panel.fix.e1"), e2: t("dep.panel.fix.e2"), e3: t("dep.panel.fix.e3"), e4: t("dep.panel.fix.e4"), e5: t("dep.panel.fix.e5"), migrate: t("dep.panel.fix.migrate") };
    NOT_READY_HINT = t("dep.panel.notReady");
    void renderDepHealth();
  });

  for (const [tab, btn] of Object.entries(tabBtns) as Array<[DepTab, HTMLButtonElement]>) {
    btn.addEventListener("click", () => void switchTab(tab));
  }
  refreshBtn.addEventListener("click", () => void manualRefresh());
  collapseBtn.addEventListener("click", () => {
    depDetailExpanded = !depDetailExpanded;
    syncDepDetail();
  });
  syncDepDetail(); // 初始收起态落 DOM（HTML 默认 hidden，此处对齐 aria-expanded）
  // 状态栏体检图标：点击/键盘打开健康面板（§4.5）——该入口语义是「看问题」，顺带展开明细
  statusEl.addEventListener("click", () => { expandDepDetail(); openPanel(); });
  statusEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      expandDepDetail();
      openPanel();
    }
  });
}

/** 切换/关闭工作区复位（main 的 resetWorkspaceUiState 调用）：清投影 DOM + 视图状态归位 */
export function resetDepHealthPanel(): void {
  currentTab = "edge";
  depDetailExpanded = false; // 切工作区回到默认收起（新工作区的问题由横幅重新宣告）
  syncDepDetail();
  groupOpen.clear();
  syncTabButtons();
  bannerEl.classList.add("hidden");
  bannerTextEl.textContent = "";
  bannerActionsEl.textContent = "";
  contentEl.textContent = "";
  styleBadgeEl.textContent = "";
  styleBadgeEl.classList.remove("clickable");
  styleBadgeEl.onclick = null;
  interpLabelEl.textContent = "";
  scannedAtEl.textContent = "";
  setHealthStatus("idle");
}

// ---------- 状态栏体检图标（§4.5：转圈→完成即消；异常驻留警示，点击开面板） ----------

export type HealthStatus = "idle" | "scanning" | "ok" | "issues";

export function setHealthStatus(status: HealthStatus, issues = 0): void {
  statusEl.textContent = "";
  statusEl.classList.toggle("hidden", status === "idle" || status === "ok");
  statusEl.classList.toggle("issues", status === "issues");
  if (status === "scanning") {
    statusEl.appendChild(spinIcon());
    statusEl.dataset.tip = t("dep.panel.statusScanning");
  } else if (status === "issues") {
    statusEl.appendChild(codicon("warning"));
    statusEl.dataset.tip = t("dep.panel.statusIssues", { issues: issues });
  }
}

/** depHealth 的 onScanComplete 钩子（main 接线）：图标熄灭/驻留 + 面板打开时重绘。
 *  扫描失败（diff=null）→ 图标熄灭（失败详情已进输出面板，不静默但也不驻留假警示）。 */
export function handleScanComplete(diff: DepDiff | null): void {
  if (diff === null) setHealthStatus("idle");
  else setHealthStatus(issueCount(diff) > 0 ? "issues" : "ok", issueCount(diff));
  if (!envModalEl.classList.contains("hidden")) {
    void renderDepHealth();
    if (diff !== null) repaintPackages(); // #4：体检完成后重绘包行「未声明」徽标（本地重绘，不联网）
  }
}

// ---------- 渲染入口 ----------

export async function renderDepHealth(): Promise<void> {
  renderBanner();
  renderHeader();
  await renderContent();
}

/** 三视图分发（§6.1：按断边默认 / 按文件 / 已忽略） */
async function renderContent(): Promise<void> {
  const diff = latestDiff();
  if (currentTab === "edge") renderEdgeView(diff);
  else if (currentTab === "file") renderFileView(diff);
  else await renderIgnoredView();
}

async function switchTab(tab: DepTab): Promise<void> {
  currentTab = tab;
  syncTabButtons();
  await renderContent();
}

function syncTabButtons(): void {
  for (const [t, btn] of Object.entries(tabBtns) as Array<[DepTab, HTMLButtonElement]>) {
    btn.setAttribute("aria-selected", String(t === currentTab));
  }
}

/** 手动刷新（§4.5：行内转圈 + 按钮禁用，不遮罩、不阻塞面板其他分区） */
async function manualRefresh(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || depFixBusy()) return;
  setBusy(refreshBtn, true, t("dep.panel.refreshing"));
  setHealthStatus("scanning");
  await refreshStyleInfo();
  await runDepScan(root); // 落快照 → onScanComplete → handleScanComplete 重绘
  setBusy(refreshBtn, false);
}

// ---------- 健康横幅（§6.2：四级优先级，同一时刻最多一条，高优先级胜出） ----------

interface BannerButton {
  label: string;
  primary?: boolean;
  /** 修复类按钮：执行期间随 .dep-fix-btn 统一禁用（§5.6-3 防重入） */
  fix?: boolean;
  run: (btn: HTMLButtonElement) => void;
}
interface BannerModel {
  text: string;
  buttons: BannerButton[];
}

function bannerFor(diff: DepDiff | null, styleInfo: DepStyleInfo | null): BannerModel | null {
  const style = diff?.style ?? styleInfo?.style ?? null;
  const mgr = diff?.externalManager ?? styleInfo?.externalManager ?? null;
  // 优先级 1：external 边界横幅（§4.2.1——把沉默的失效变成有解释的边界，防「误判 bug」）
  if (style === "external") {
    return {
      text: t("dep.panel.externalLock", { mgr: mgr ?? t("dep.panel.externalMgr") }),
      buttons: [{ label: t("dep.panel.act.migrateInfo"), run: () => showMigrationGuide() }],
    };
  }
  // 优先级 2：bare（原 env-pyproject-banner 并入此处，动作仍复用 init_pyproject）
  if (style === "bare") {
    return {
      text: t("dep.panel.bareText"),
      buttons: [{ label: t("dep.panel.act.genPyproject"), primary: true, run: (btn) => void generatePyproject(btn) }],
    };
  }
  // 优先级 3/4 需要全量 diff（L0 style 阶段无环境侧事实）
  if (!diff) return null;
  // 优先级 3：E2 非空（含 requirementsUninstalled 特例——用户反馈 1 的直接解）
  if (diff.requirementsUninstalled) {
    return {
      text: t("dep.panel.e2Banner", { file: diff.requirementsFile ?? "requirements.txt", count: diff.declaredMissing.length }),
      buttons: [
        { label: t("dep.panel.act.installMissing"), primary: true, fix: true, run: () => void fixGroup("e2") },
        { label: t("dep.panel.fix.migrate"), fix: true, run: () => void fixGroup("migrate") },
      ],
    };
  }
  if (diff.declaredMissing.length > 0) {
    return {
      text: t("dep.panel.e2Short", { count: diff.declaredMissing.length }),
      buttons: [{
        label: diff.style === "pyproject" ? t("dep.panel.fix.e2") : t("dep.panel.act.installMissing"),
        primary: true, fix: true, run: () => void fixGroup("e2"),
      }],
    };
  }
  // 优先级 4：envDrift（用户反馈 2：终端 uv pip install 后 pyproject 不同步）
  if (diff.envDrift.length > 0) {
    const buttons: BannerButton[] = [];
    if (diff.style === "pyproject") {
      buttons.push({ label: t("dep.panel.act.declarePyproject"), primary: true, fix: true, run: () => void fixGroup("e3") });
    }
    buttons.push({ label: t("dep.action.view"), run: () => void showEdgeGroup("e3") });
    return {
      text: t("dep.panel.e3Banner", { count: diff.envDrift.length }),
      buttons,
    };
  }
  return null;
}

function renderBanner(): void {
  const model = bannerFor(latestDiff(), latestStyleInfo());
  bannerTextEl.textContent = "";
  bannerActionsEl.textContent = "";
  if (!model) {
    bannerEl.classList.add("hidden");
    return;
  }
  bannerEl.classList.remove("hidden");
  bannerTextEl.textContent = model.text;
  for (const b of model.buttons) {
    const btn = document.createElement("button");
    btn.className = b.primary ? "btn btn--sm btn--primary" : "btn btn--sm";
    if (b.fix) btn.classList.add("dep-fix-btn");
    btn.textContent = b.label;
    btn.addEventListener("click", () => b.run(btn));
    bannerActionsEl.appendChild(btn);
  }
}

// ---------- 常驻头部（§6.1：style 徽章 + 解释器 + 上次扫描 + 刷新） ----------

function renderHeader(): void {
  const diff = latestDiff();
  const styleInfo = latestStyleInfo();
  const style = diff?.style ?? styleInfo?.style ?? null;
  const mgr = diff?.externalManager ?? styleInfo?.externalManager ?? null;
  styleBadgeEl.textContent = style ? (mgr ? `${style}·${mgr}` : style) : t("dep.panel.notScanned");
  // §6.1 徽章交互：external → 边界说明与迁移建议；bare → 生成 pyproject 引导
  styleBadgeEl.classList.toggle("clickable", style === "external" || style === "bare");
  styleBadgeEl.dataset.tip =
    style === "external" ? t("dep.panel.badge.external")
    : style === "bare" ? t("dep.panel.badge.bare")
    : t("dep.panel.badge.default");
  styleBadgeEl.onclick = () => {
    if (style === "external") showMigrationGuide();
    else if (style === "bare") void generatePyproject(null);
  };
  // §3.3：interpreter=null 时 UI 须显式呈现「环境侧检测不可用」
  interpLabelEl.textContent = diff
    ? diff.interpreter ? shortInterpreter(diff.interpreter) : t("dep.summary.interpMissing")
    : "";
  scannedAtEl.textContent = diff ? t("dep.panel.scannedAt", { time: new Date(diff.scannedAt).toLocaleTimeString() }) : "";
}

// ---------- 视图一：按断边（§6.1 默认视图） ----------

interface GroupMeta {
  count: number;
  /** external 降级（§9.1 边界验收：显示「已降级」而非空列表） */
  degraded: boolean;
  note: string | null;
}

function groupMeta(edge: EdgeId, diff: DepDiff): GroupMeta {
  const noInterp = diff.interpreter === null;
  const noInterpNote = t("dep.panel.noInterpNote");
  if (diff.style === "external" && edge !== "e1") {
    return {
      count: 0,
      degraded: true,
      note: t("dep.panel.e2DegradedNote", { mgr: diff.externalManager ?? t("dep.panel.externalTool") }),
    };
  }
  switch (edge) {
    case "e1":
      return { count: diff.missingInEnv.length, degraded: false, note: noInterp ? noInterpNote : null };
    case "e2": {
      const count = diff.declaredMissing.length + diff.declaredMissingModules.length;
      return { count, degraded: false, note: noInterp ? noInterpNote : null };
    }
    case "e3":
      return { count: diff.envDrift.length, degraded: false, note: noInterp ? noInterpNote : null };
    case "e4": {
      const note = diff.style === "pyproject"
        ? null
        : t("dep.panel.e4Note", { style: diff.style, suffix: diff.style === "requirements" ? t("dep.panel.e4ReqSuffix") : "" });
      return { count: diff.undeclared.length, degraded: false, note };
    }
    case "e5":
      return { count: diff.lockOutOfDate ? 1 : 0, degraded: false, note: null };
  }
}

// ---------- 三视图 ----------

function renderEdgeView(diff: DepDiff | null): void {
  contentEl.textContent = "";
  if (!diff) {
    // S4 空态教学（onboarding plan §3.4 缺口 2）：区分「尚未体检」与「没有可体检的声明文件」——
    // bare 工作区（无 pyproject / requirements）体检结果天然为空，此时教用户「这面板属于谁」。
    const style = latestStyleInfo()?.style;
    contentEl.appendChild(hintEl(
      style === "bare"
        ? t("dep.panel.noDeclaration")
        : NOT_READY_HINT,
    ));
    return;
  }
  for (const edge of ["e1", "e2", "e3", "e4", "e5"] as EdgeId[]) {
    contentEl.appendChild(renderGroup(edge, diff));
  }
  // requirements 迁移引导（R4：迁移而非原地维护；只读原文件可回退）
  if (diff.style === "requirements") {
    const plan = groupFixPlan(diff, "migrate");
    const { row, actions } = depRow([
      nameSpan(t("dep.panel.migrateTitle")),
      detailSpan(t("dep.panel.migrateDetail")),
    ]);
    if (plan) {
      actions.append(actionBtn(t("dep.panel.fix.migrate"), () => void runPlans([plan], FIX_TITLES.migrate), { fix: true }));
    }
    const wrap = document.createElement("div");
    wrap.className = "dep-group";
    wrap.appendChild(row);
    contentEl.appendChild(wrap);
  }
}

function renderGroup(edge: EdgeId, diff: DepDiff): HTMLElement {
  const meta = groupMeta(edge, diff);
  const wrap = document.createElement("div");
  wrap.className = "dep-group";
  wrap.dataset.edge = edge;

  const head = document.createElement("div");
  head.className = "dep-group-head";
  const expanded = isGroupOpen(edge, meta.count);
  const caret = codicon("chevron-right");
  caret.classList.add("dep-caret");
  if (expanded) caret.classList.add("expanded");
  const title = document.createElement("span");
  title.className = "dep-group-title";
  title.textContent = EDGE_TITLES[edge];
  const count = document.createElement("span");
  count.className = "dep-group-count";
  count.textContent = meta.degraded ? t("dep.panel.degradedTag") : t("dep.panel.countItems", { count: meta.count });
  head.append(caret, title, count);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.appendChild(spacer);
  // 组级「全部修复」（§5.3 批量预览：确认弹窗列命令清单）——不可修（降级/无解释器/非 pyproject）不出按钮；
  // 折叠态也出按钮（#3：大组默认折叠，但批量动作须可达，不必先展开再修）
  const plan = meta.degraded ? null : groupFixPlan(diff, edge);
  if (plan && meta.count > 0) {
    // #6：E3 组头按钮文案与横幅/行级「写入 pyproject」对齐——消除「全部修复 vs 写入 pyproject
    // 是否不同操作」的困惑（其余断边仍用通用「全部修复」）
    const fixLabel = edge === "e3" ? t("dep.panel.fixAllDeclare") : t("dep.panel.fixAll");
    head.appendChild(actionBtn(fixLabel, () => void runPlans([plan], FIX_TITLES[edge]), { fix: true, accent: true }));
  }
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return; // 按钮点击不触发折叠
    groupOpen.set(edge, !expanded);
    void renderContent();
  });
  wrap.appendChild(head);

  if (expanded) {
    if (meta.note) wrap.appendChild(noteEl(meta.note));
    if (!meta.degraded) {
      const rows = edgeRows(edge, diff);
      for (const r of rows) wrap.appendChild(r);
      if (meta.count === 0 && !meta.note) wrap.appendChild(noteEl(t("dep.panel.noIssues")));
    }
  }
  return wrap;
}

function edgeRows(edge: EdgeId, diff: DepDiff): HTMLElement[] {
  switch (edge) {
    case "e1": {
      // v1.7 B：按模块聚合（「pytest（5 个文件）」一行 + 展开明细）——missingInEnv 契约
      // 保持 (module,file) 粒度（预检按文件消费），聚合是纯呈现层
      const byModule = new Map<string, typeof diff.missingInEnv>();
      for (const m of diff.missingInEnv) {
        const list = byModule.get(m.module) ?? [];
        list.push(m);
        byModule.set(m.module, list);
      }
      const rows: HTMLElement[] = [];
      for (const [module, items] of byModule) {
        const first = items[0];
        const allLazy = items.every((m) => m.lazy);
        const { row, actions } = depRow([
          nameSpan(module),
          detailSpan(
            first.distCandidates.length > 1
              ? t("dep.panel.candidates", { cands: first.distCandidates.join(" / ") })
              : first.dist ? t("dep.panel.willInstall", { dist: first.dist }) : t("dep.panel.willInstallByModule"),
          ),
          fileLink(first.file, first.line),
          ...(items.length > 1 ? [countTag(t("dep.panel.fileCount", { count: items.length }))] : []),
          ...(allLazy ? [lazyTag()] : []),
        ]);
        actions.append(
          actionBtn(
            t("dep.action.install"),
            () => void fixSingleWithCandidates("install", module, first.distCandidates, first.dist, FIX_TITLES.e1, first.dist === null ? NULL_DIST_WARNING : undefined),
            { fix: true, accent: true },
          ),
          actionBtn(t("dep.panel.act.ignore"), () => void ignoreEntry("e1", module)),
        );
        rows.push(row);
        // 多文件明细（展开态视觉：缩进列出其余位点）
        if (items.length > 1) {
          for (const m of items.slice(1)) {
            const { row: sub } = depRow([detailSpan("↳"), fileLink(m.file, m.line), ...(m.lazy && !allLazy ? [lazyTag()] : [])]);
            sub.classList.add("dep-row--sub");
            rows.push(sub);
          }
        }
      }
      return rows;
    }
    case "e2": {
      const rows: HTMLElement[] = [];
      // 小节一：同步范围缺失（core 逐条，既有形态）
      for (const d of diff.declaredMissing) {
        const spec = `${d.dist}${d.spec}`;
        const { row, actions } = depRow([
          nameSpan(d.dist),
          detailSpan(d.spec ? t("dep.panel.declaredSpec", { spec: d.spec }) : t("dep.panel.noSpec")),
        ]);
        actions.append(
          actionBtn(t("dep.action.install"), () => void fixSingle("install", [spec], FIX_TITLES.e1), { fix: true, accent: true }),
          actionBtn(t("dep.panel.act.ignore"), () => void ignoreEntry("e2", d.dist)),
        );
        rows.push(row);
      }
      // 小节二（v1.7 A）：已声明未安装的代码引用——按模块聚合汇总（fika-admin pytest ×5
      // 降噪形态：已写入声明（extras/groups）但环境未装，E1 分流至此；一条含安装命令建议）
      if (diff.declaredMissingModules.length > 0) {
        rows.push(noteEl(t("dep.panel.e2GroupHead")));
        const byGroup = new Map<string, typeof diff.declaredMissingModules>();
        for (const m of diff.declaredMissingModules) {
          const list = byGroup.get(m.group) ?? [];
          list.push(m);
          byGroup.set(m.group, list);
        }
        for (const [group, mods] of byGroup) {
          const first = mods[0];
          const spec = mods.map((m) => m.dist).join(" ");
          const { row, actions } = depRow([
            nameSpan(mods.map((m) => m.module).join("、")),
            detailSpan(t("dep.panel.groupRef", { group: group, files: mods.reduce((s, m) => s + m.files, 0) })),
            fileLink(first.file, first.line),
            ...(first.lazy ? [lazyTag()] : []),
          ]);
          actions.append(
            actionBtn(t("dep.action.install"), () => void fixSingle("install", [spec], t("dep.panel.installGroup", { group: group })), { fix: true, accent: true }),
            actionBtn(t("dep.panel.act.ignore"), () => void ignoreEntry("e2", mods[0].module)),
          );
          rows.push(row);
        }
      }
      return rows;
    }
    case "e3":
      return diff.envDrift.map((d) => {
        const cells: Array<HTMLElement | string> = [nameSpan(d.dist), detailSpan(t("dep.panel.installedVer", { version: d.version || t("dep.panel.versionUnknown") }))];
        const { row, actions } = depRow(cells);
        // 写声明仅 pyproject 可行；requirements/bare 的收敛路径是迁移（视图底部单独提供）
        if (diff.style === "pyproject") {
          actions.append(actionBtn(t("dep.panel.act.declarePyproject"), () => void fixSingle("declare", [driftSpec(d)], FIX_TITLES.e3), { fix: true, accent: true }));
        }
        actions.append(actionBtn(t("dep.panel.act.ignore"), () => void ignoreEntry("e3", d.dist)));
        return row;
      });
    case "e4":
      return diff.undeclared.map((u) => {
        const { row, actions } = depRow([
          nameSpan(u.module),
          detailSpan(
            u.distCandidates.length > 1
              ? t("dep.panel.installedCandidates", { cands: u.distCandidates.join(" / ") })
              : u.dist ? t("dep.panel.installedUndeclared", { dist: u.dist }) : t("dep.panel.installedNoDist"),
          ),
          fileLink(u.file, u.line),
        ]);
        actions.append(
          actionBtn(
            t("dep.panel.act.declareOne"),
            () => void fixSingleWithCandidates("declare", u.module, u.distCandidates, u.dist, FIX_TITLES.e4, u.dist === null ? NULL_DIST_WARNING : undefined),
            { fix: true, accent: true },
          ),
          actionBtn(t("dep.panel.act.ignore"), () => void ignoreEntry("e4", u.module)),
        );
        return row;
      });
    case "e5":
      if (!diff.lockOutOfDate) return [];
      {
        const { row, actions } = depRow([
          nameSpan(t("dep.panel.lockMismatch")),
          detailSpan(t("dep.panel.lockCheckDetail")),
        ]);
        actions.append(actionBtn(t("dep.panel.act.refreshLock"), () => void fixGroup("e5"), { fix: true, accent: true }));
        return [row];
      }
  }
}

// ---------- 视图二：按文件（missingInEnv / undeclared 按文件聚合，点击跳转） ----------

interface FileItem { line: number; module: string; label: string; dist: string | null }

function renderFileView(diff: DepDiff | null): void {
  contentEl.textContent = "";
  if (!diff) {
    // S4 空态教学：与按断边视图同口径（bare 工作区 vs 尚未体检）
    const style = latestStyleInfo()?.style;
    contentEl.appendChild(hintEl(
      style === "bare"
        ? t("dep.panel.noDeclaration")
        : NOT_READY_HINT,
    ));
    return;
  }
  const byFile = new Map<string, FileItem[]>();
  const push = (file: string, item: FileItem): void => {
    const list = byFile.get(file);
    if (list) list.push(item);
    else byFile.set(file, [item]);
  };
  for (const m of diff.missingInEnv) push(m.file, { line: m.line, module: m.module, label: t("dep.panel.file.e1"), dist: m.dist });
  for (const u of diff.undeclared) push(u.file, { line: u.line, module: u.module, label: t("dep.panel.file.e4"), dist: u.dist });
  if (byFile.size === 0) {
    contentEl.appendChild(hintEl(t("dep.panel.fileClean")));
    return;
  }
  const files = [...byFile.keys()].sort();
  for (const file of files) {
    const items = (byFile.get(file) ?? []).slice().sort((a, b) => a.line - b.line);
    const wrap = document.createElement("div");
    wrap.className = "dep-group";
    const head = document.createElement("div");
    head.className = "dep-group-head";
    const title = document.createElement("span");
    title.className = "dep-group-title dep-link";
    title.textContent = file;
    title.dataset.tip = t("dep.panel.jumpFirstTip");
    title.addEventListener("click", () => gotoFromLink({ path: file, line: items[0]?.line ?? 1 }));
    const count = document.createElement("span");
    count.className = "dep-group-count";
    count.textContent = t("dep.panel.countItems", { count: items.length });
    head.append(title, count);
    wrap.appendChild(head);
    for (const it of items) {
      const { row } = depRow([
        nameSpan(`L${it.line}`),
        detailSpan(`${it.module} — ${it.label}${it.dist ? `（${it.dist}）` : ""}`),
      ]);
      const link = document.createElement("span");
      link.className = "dep-link";
      link.textContent = t("dep.panel.act.jump");
      link.addEventListener("click", () => gotoFromLink({ path: file, line: it.line }));
      row.insertBefore(link, row.querySelector(".spacer"));
      wrap.appendChild(row);
    }
    contentEl.appendChild(wrap);
  }
}

// ---------- 视图三：已忽略（§5.3：忽略清单管理，移除即恢复检测） ----------

async function renderIgnoredView(): Promise<void> {
  contentEl.textContent = "";
  const root = app.workspaceRoot;
  if (!root) return;
  let list: DepIgnoreEntry[] = [];
  try {
    list = await invoke<DepIgnoreEntry[]>("dep_ignore_list", { workspaceRoot: root });
  } catch (e) {
    contentEl.appendChild(hintEl(t("dep.panel.ignoreReadFailed", { error: localizeBackendError(errMsg(e)) })));
    return;
  }
  if (list.length === 0) {
    contentEl.appendChild(hintEl(t("dep.panel.noIgnored")));
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "dep-group";
  for (const entry of list) {
    const { row, actions } = depRow([
      nameSpan(entry.key),
      detailSpan(EDGE_LABELS[entry.edge] ?? entry.edge),
    ]);
    actions.append(actionBtn(t("dep.panel.act.restore"), () => void restoreIgnored(entry), { accent: true }));
    wrap.appendChild(row);
  }
  contentEl.appendChild(wrap);
}

async function ignoreEntry(edge: string, key: string): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  try {
    await invoke("dep_ignore_add", { workspaceRoot: root, edge, key });
    toast(t("dep.panel.ignoredToast", { key: key }), "success");
    await rescanAndRender(root); // 后端过滤的新 diff 落快照；面板重绘后条目消失
  } catch (e) {
    toastFail(t("dep.panel.act.ignore"), e);
  }
}

async function restoreIgnored(entry: DepIgnoreEntry): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  try {
    await invoke("dep_ignore_remove", { workspaceRoot: root, edge: entry.edge, key: entry.key });
    toast(t("dep.panel.restoredToast", { key: entry.key }), "success");
    await rescanAndRender(root);
  } catch (e) {
    toastFail(t("dep.panel.act.restore"), e);
  }
}

/** 忽略清单变化 → 重扫（后端过滤单一口径）→ 重绘。扫描失败也重绘（呈现降级形态） */
async function rescanAndRender(root: string): Promise<void> {
  await runDepScan(root);
  await renderDepHealth();
}

// ---------- 修复动作（编排在 depHealth.runDepFix；本层管按钮禁用与面板刷新） ----------

async function fixGroup(edge: "e1" | "e2" | "e3" | "e4" | "e5" | "migrate"): Promise<void> {
  const diff = latestDiff();
  if (!diff) return;
  const plan = groupFixPlan(diff, edge);
  if (!plan) return;
  await runPlans([plan], FIX_TITLES[edge]);
}

async function fixSingle(action: DepFixAction, dists: string[], title: string, warning?: string): Promise<void> {
  const diff = latestDiff();
  if (!diff) return;
  await runPlans([{ action, dists, command: fixCommandPreview(diff, action, dists), warning }], title);
}

/** M4-4 dist 歧义：行级安装/写入动作先过候选选择（多候选弹 openChoice，单候选直取；
 *  无候选回退 dist ?? module——null dist 走 NULL_DIST_WARNING 提示）。用户取消 = 不执行。 */
async function fixSingleWithCandidates(
  action: DepFixAction,
  module: string,
  candidates: string[],
  fallbackDist: string | null,
  title: string,
  warning?: string,
): Promise<void> {
  let spec: string;
  if (candidates.length > 1) {
    const chosen = await resolveDistForInstall(module, candidates);
    if (chosen === null) return; // 取消选择
    spec = chosen;
  } else {
    spec = fallbackDist ?? module;
  }
  await fixSingle(action, [spec], title, warning);
}

/** §5.6-3 防重入：执行期间面板 + 横幅的全部修复按钮同步禁用；成功后包列表联动刷新 */
async function runPlans(plans: DepFixPlan[], title: string): Promise<void> {
  if (depFixBusy()) {
    toast(t("dep.busyToast"), "info");
    return;
  }
  setFixButtonsDisabled(true);
  const ok = await runDepFix(plans, title);
  setFixButtonsDisabled(false);
  if (ok) refreshPackages(); // dep_fix 装/卸包改变环境内容——面板打开时包列表联动（§5.2 收尾的 UI 延伸）
  await renderDepHealth(); // 收尾协议的 runDepScan 已触发 onScanComplete 重绘；此处兜底（取消/失败路径）
}

function setFixButtonsDisabled(disabled: boolean): void {
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".dep-fix-btn"))) {
    b.disabled = disabled;
  }
}

// ---------- 横幅/徽章动作 ----------

/** bare 徽章与横幅共用：一键幂等生成最小 pyproject.toml（原 envPanel.generatePyproject 迁入） */
async function generatePyproject(btn: HTMLButtonElement | null): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  if (btn) setBusy(btn, true, t("dep.panel.generating"));
  try {
    await invoke<string>("init_pyproject", { workspaceRoot: root });
    toast(t("dep.panel.pyprojectGenerated"), "success");
    await refreshStyleInfo(); // style 徽章/横幅即时翻转（bare → pyproject），不必等全量扫描
    await runDepScan(root);
  } catch (e) {
    appendOutputLine(outputEl, t("dep.panel.genFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
    toastFail(t("dep.panel.act.genPyproject"), e);
  }
  if (btn) setBusy(btn, false);
  await renderDepHealth();
}

/** external 边界说明 + uv 迁移建议（§4.2.1/§6.1 徽章点击展开） */
function showMigrationGuide(): void {
  const mgr = latestDiff()?.externalManager ?? latestStyleInfo()?.externalManager ?? t("dep.panel.externalTool");
  void openAlert({
    title: t("dep.panel.migrateGuideTitle"),
    // 迁移指南多段拼装（含 \n\n / \n 不走 apply_ts 映射，避免语言包转义链失真），按段取词
    message:
      t("dep.panel.guideHead", { mgr: mgr }) +
      `${t("dep.panel.guideDisabled")}\n\n` +
      `${t("dep.panel.guideSteps")}\n` +
      `${t("dep.panel.guideStep1")}\n` +
      `${t("dep.panel.guideStep2")}\n` +
      t("dep.panel.guideStep3", { mgr: mgr }),
  });
}

/** 横幅「查看」：切到按断边视图、展开目标分组并滚动到可见（明细收起时先展开）。
 *  groupOpen.set(edge, true) 强制展开——即使该组因 count 超阈值默认折叠（#3），「查看」也要展开它。 */
async function showEdgeGroup(edge: EdgeId): Promise<void> {
  expandDepDetail();
  groupOpen.set(edge, true);
  await switchTab("edge");
  contentEl.querySelector(`[data-edge="${edge}"]`)?.scrollIntoView({ block: "nearest" });
}

// ---------- 小构件（全部 textContent 防注入） ----------

function hintEl(msg: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "dep-empty";
  el.textContent = msg;
  return el;
}

function noteEl(msg: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "dep-group-note";
  el.textContent = msg;
  return el;
}

function nameSpan(text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "dep-name";
  s.textContent = text;
  return s;
}

function detailSpan(text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "dep-detail";
  s.textContent = text;
  return s;
}

function lazyTag(): HTMLElement {
  const s = document.createElement("span");
  s.className = "dep-lazy-tag";
  s.textContent = t("dep.panel.lazyTag");
  s.dataset.tip = t("dep.panel.lazyTip");
  return s;
}

/** v1.7 B：模块聚合的文件计数徽标 */
function countTag(text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "dep-count-tag";
  s.textContent = text;
  return s;
}

function fileLink(file: string, line: number): HTMLElement {
  const a = document.createElement("span");
  a.className = "dep-link";
  a.textContent = `${file}:${line}`;
  a.dataset.tip = t("dep.panel.jumpTip");
  a.addEventListener("click", () => gotoFromLink({ path: file, line }));
  return a;
}

function actionBtn(
  label: string,
  run: () => void,
  opts: { fix?: boolean; accent?: boolean } = {},
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `dep-btn${opts.accent ? " accent" : ""}${opts.fix ? " dep-fix-btn" : ""}`;
  b.textContent = label;
  b.addEventListener("click", () => run());
  return b;
}

/** 行骨架：cells + 弹性空隙 + 动作区（对齐 .env-pkg-line 的布局范式） */
function depRow(cells: Array<HTMLElement | string>): { row: HTMLElement; actions: HTMLElement } {
  const row = document.createElement("div");
  row.className = "dep-row";
  for (const c of cells) row.append(typeof c === "string" ? detailSpan(c) : c);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const actions = document.createElement("span");
  actions.className = "dep-actions";
  row.append(spacer, actions);
  return { row, actions };
}
