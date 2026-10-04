// 状态栏「静态语义引擎」chip（C2）：身份展示 + 切换入口。
// 引擎真值统一收敛到 app.settings.lsp_engine（修复原先 menubar select 与 settings 分叉的 bug）：
// chip 只做「渲染 settings + 写回 settings + 持久化 + 重启」，不再有第二份 DOM 真值。
// main.ts 与 settingsPanel.ts 都从本模块 import renderEngineChip，避免把 chip 渲染散在两处；
// startLsp / saveSettings 经 handler 注入，本模块不反向依赖 main.ts / settingsPanel.ts（无循环导入）。

import { app, lazyEl } from "./state";
import { showMenu } from "./menu";
import { t } from "./i18n"; // 第十六批 i18n：引擎芯片动态文案走语言包

export interface EngineChipHandlers {
  /** 重启静态引擎（main.ts 的 startLsp，现已改读 app.settings.lsp_engine） */
  startLsp: () => Promise<void>;
  /** 持久化设置（settingsPanel.ts 的 saveSettings） */
  saveSettings: () => Promise<void>;
}

let handlers: EngineChipHandlers | null = null;
// CR-26：顶层 DOM 快照改惰性（规则：顶层禁止解析 DOM；测试环境可安全 import）
const statusEngineEl = lazyEl("status-engine");

// E-2（PyCharm 调研）：引擎忙碌态（引用计数：引擎 starting 与 references/rename 查询可叠加）
let busyDepth = 0;

/** 忙碌态开关（引用计数）：main 在引擎 starting/ready 切换，findUsages/renameWidget 在查询期间置位 */
export function setEngineBusy(busy: boolean): void {
  const next = Math.max(0, busyDepth + (busy ? 1 : -1));
  if (next === busyDepth) return;
  busyDepth = next;
  renderEngineChip();
}

/** 供 e2e/展示读取（内部判定用 busyDepth） */
export function isEngineBusy(): boolean {
  return busyDepth > 0;
}

const ENGINES = [
  { id: "pyrefly", label: "pyrefly" },
  { id: "basedpyright", label: "basedpyright" },
];

export function setEngineChipHandlers(h: EngineChipHandlers): void {
  handlers = h;
}

/** 渲染 chip 文本（唯一真值来源 = app.settings.lsp_engine；忙碌时追加「索引中…」） */
export function renderEngineChip(): void {
  const name = app.settings.lsp_engine || "pyrefly";
  statusEngineEl.classList.toggle("busy", busyDepth > 0);
  statusEngineEl.textContent = busyDepth > 0 ? t("ide.engine.indexing", { name }) : name;
  // 纯截断披露：chip 有 max-width + ellipsis，忙碌长文案可能被截断，title 补全量
  statusEngineEl.title = busyDepth > 0 ? t("ide.engine.indexingTitle") : "";
}

/** 切换引擎：同值跳过；否则写回 settings → 持久化 → 重绘 chip → 重启 LSP */
async function switchEngine(engine: string): Promise<void> {
  if (engine === app.settings.lsp_engine) return;
  app.settings.lsp_engine = engine;
  await handlers?.saveSettings();
  renderEngineChip();
  await handlers?.startLsp();
}

/** 供其他域触发引擎切换（F0 裁决 B 的 Pydantic 引擎推荐）：
 *  同值跳过 / 持久化 / 重启语义与 chip 菜单完全一致，不另开第二份真值。 */
export function switchEngineTo(engine: string): Promise<void> {
  return switchEngine(engine);
}

/** 接线 chip 的点击 / 键盘（Enter / Space）入口 */
export function wireEngineChip(): void {
  statusEngineEl.addEventListener("click", openEngineMenu);
  statusEngineEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openEngineMenu();
    }
  });
}

function openEngineMenu(): void {
  const current = app.settings.lsp_engine;
  showMenu(
    ENGINES.map((e) => ({
      label: e.label,
      checked: e.id === current,
      action: () => void switchEngine(e.id),
    })),
    statusEngineEl,
  );
}