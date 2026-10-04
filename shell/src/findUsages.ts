// 查找引用结果面板（Alt+F7，对标 PyCharm「Find Usages」工具窗口）+ 重命名入口。
//
// - Alt+F7：全量跨文件引用落底部「引用」标签，按「引用种类」（定义/导入/调用/引用）分组
//   + 顶栏 chips 过滤；点击条目跳转并选中标识符（openRef → main.ts 注入的回调）。
// - Shift+F6 / 面板「重命名」按钮：就地改名入口（renameWidget.ts：prepareRename 锚定 +
//   ghost 预览 + Enter 全部文件一次性写入）。
// 结果树复用全局搜索面板视觉（search-file / search-match / search-hit）；跳转到文件的动作
// 经 main.ts 注入的回调执行（避免本域反向依赖 main.ts 造成循环导入）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { app, $ } from "./state";
import { setBottomTab } from "./termUi";
import { getEngineStatus, waitReferencesStable, type LspReferenceLocation } from "./lsp/client";
import { setEngineBusy } from "./engineChip";
import { basename, emptyState } from "./util";
import { toast } from "./toast";
import { startRenameAtCursor } from "./renameWidget";
import { t } from "./i18n"; // 第十三批 i18n：动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { errMsg } from "./util";

/** 引用种类（启发式归类，对齐 PyCharm Find Usages 的核心分组） */
type RefKind = "definition" | "import" | "call" | "reference";

/** 单个引用：client.Location + 行文本 + 种类 */
interface RefItem extends LspReferenceLocation {
  text: string;
  kind: RefKind;
}

/** 跳转回调（main.ts 注入：打开文件 + 选中标识符 + 居中 + 聚焦） */
let onOpenRef:
  | ((path: string, line: number, col: number, endLine?: number, endCol?: number) => void)
  | null = null;
export function setOpenRefHandler(
  fn: (path: string, line: number, col: number, endLine?: number, endCol?: number) => void,
): void {
  onOpenRef = fn;
}

/** 跳转到某个引用（引用面板 / Code Vision 弹层共用；由 main.ts 注入的回调执行） */
export function openRef(ref: LspReferenceLocation): void {
  onOpenRef?.(ref.path, ref.line, ref.col, ref.endLine, ref.endCol);
}

/** 引用行文本缓存（单次查询内同文件复用） */
const fileLinesCache = new Map<string, string[]>();

async function readLines(path: string): Promise<string[]> {
  const hit = fileLinesCache.get(path);
  if (hit) return hit;
  try {
    const content = await invoke<string>("read_file", { path });
    const lines = content.split(/\r?\n/);
    fileLinesCache.set(path, lines);
    return lines;
  } catch {
    return [];
  }
}

/** 引用行文本（Code Vision 弹层复用；带单次查询内缓存） */
export async function readRefLines(path: string): Promise<string[]> {
  return readLines(path);
}

function panelEl(): HTMLElement {
  return $("find-usages-panel");
}

const KIND_ORDER: RefKind[] = ["definition", "import", "call", "reference"];
const KIND_LABEL: Record<RefKind, string> = {
  definition: t("ide.fu.kindDefinition"),
  import: t("ide.fu.kindImport"),
  call: t("ide.fu.kindCall"),
  reference: t("ide.fu.kindReference"),
};

/** 启发式分类：按行文本 + 符号后字符判定 usage kind */
function classifyRef(it: { text: string; col: number; endCol: number }): RefKind {
  const t = it.text.trimStart();
  if (/^from\s+\S+\s+import\b|^import\s+/.test(t)) return "import";
  if (/^(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/.test(t)) return "definition";
  if (it.text[it.endCol - 1] === "(") return "call";
  return "reference";
}

// ---------- 最近一次结果（供 chips 过滤重渲染） ----------

let lastItems: RefItem[] = [];
let activeKind: RefKind | "all" = "all";
/** E-2：上次查询索引是否已稳定（false → 结果面板顶部显示完整性提示，chips 切换重渲染时保留） */
let lastStable = true;

function renderRefText(container: HTMLElement, it: RefItem): void {
  const text = it.text;
  const start = it.col - 1;
  const lead = text.length - text.trimStart().length;
  const rel = start - lead;
  const before = rel > 0 ? text.slice(0, Math.min(rel, 60)) : "";
  const hitStart = Math.max(0, rel);
  const hitEnd = Math.min(text.length, hitStart + Math.max(1, it.endCol - it.col));
  const hit = text.slice(hitStart, hitEnd);
  const after = text.slice(hitEnd, hitEnd + 60);
  if (before) container.appendChild(document.createTextNode(before));
  if (hit) {
    const mark = document.createElement("span");
    mark.className = "search-hit";
    mark.textContent = hit;
    container.appendChild(mark);
  }
  if (after) container.appendChild(document.createTextNode(after));
}

function buildRefLine(it: RefItem): HTMLElement {
  const lineEl = document.createElement("div");
  lineEl.className = "search-match";
  lineEl.tabIndex = 0;
  const lineNo = document.createElement("span");
  lineNo.className = "search-line-no";
  lineNo.textContent = String(it.line);
  const textEl = document.createElement("span");
  textEl.className = "search-match-text";
  renderRefText(textEl, it);
  lineEl.append(lineNo, textEl);
  const go = (): void => openRef(it);
  lineEl.addEventListener("click", go);
  lineEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  return lineEl;
}

function buildFileHeader(path: string, total: number): HTMLElement {
  const fileEl = document.createElement("div");
  fileEl.className = "search-file";
  const name = document.createElement("div");
  name.className = "search-file-name";
  name.textContent = `${basename(path)} (${total})`;
  name.title = path;
  fileEl.appendChild(name);
  return fileEl;
}

function buildChip(kind: RefKind | "all", label: string, count: number, active: boolean): HTMLElement {
  const b = document.createElement("button");
  b.className = "fu-chip" + (active ? " active" : "");
  b.dataset.kind = kind;
  b.textContent = `${label} (${count})`;
  b.addEventListener("click", () => {
    activeKind = kind;
    render();
  });
  return b;
}

/** 「重命名」按钮：对上次查询的符号发起跨文件重命名 */
function buildRenameButton(): HTMLElement {
  const b = document.createElement("button");
  b.className = "fu-chip fu-rename-btn";
  b.textContent = t("ide.fu.renameBtn");
  b.title = t("ide.fu.renameTip");
  b.addEventListener("click", () => void renameSymbolAtCursor());
  return b;
}

function buildResults(filter: RefKind | "all"): HTMLElement {
  const root = document.createElement("div");
  const kinds = filter === "all" ? KIND_ORDER : [filter];
  for (const k of kinds) {
    const group = lastItems.filter((i) => i.kind === k);
    if (group.length === 0) continue;
    const kindHeader = document.createElement("div");
    kindHeader.className = "fu-kind-header";
    kindHeader.textContent = `${KIND_LABEL[k]} · ${group.length}`;
    root.appendChild(kindHeader);
    const byFile = new Map<string, RefItem[]>();
    for (const it of group) {
      const arr = byFile.get(it.path) ?? [];
      arr.push(it);
      byFile.set(it.path, arr);
    }
    for (const [path, list] of byFile) {
      root.appendChild(buildFileHeader(path, list.length));
      for (const it of list) root.appendChild(buildRefLine(it));
    }
  }
  return root;
}

/** E-2：结果完整性提示条（对应 lazy 索引「结果不完整但不说」的教训，§3.2） */
function buildIntegrityHint(): HTMLElement {
  const el = document.createElement("div");
  el.className = "fu-integrity-hint";
  el.textContent = t("ide.fu.indexIncomplete");
  return el;
}

function render(): void {
  const panel = panelEl();
  panel.textContent = "";
  const toolbar = document.createElement("div");
  toolbar.className = "find-usages-toolbar";
  toolbar.appendChild(buildChip("all", t("ide.fu.chipAll"), lastItems.length, activeKind === "all"));
  for (const k of KIND_ORDER) {
    const n = lastItems.filter((i) => i.kind === k).length;
    if (n > 0) toolbar.appendChild(buildChip(k, KIND_LABEL[k], n, activeKind === k));
  }
  const spacer = document.createElement("span");
  spacer.className = "fu-toolbar-spacer";
  toolbar.appendChild(spacer);
  toolbar.appendChild(buildRenameButton());
  panel.appendChild(toolbar);
  if (!lastStable) panel.appendChild(buildIntegrityHint()); // E-2
  const results = document.createElement("div");
  results.className = "find-usages-results";
  results.appendChild(buildResults(activeKind));
  panel.appendChild(results);
}

function renderEmpty(desc: string): void {
  const el = panelEl();
  el.textContent = "";
  el.appendChild(emptyState("search", t("ide.fu.emptyTitle"), desc));
}

/** 查询并渲染引用列表（Alt+F7 与重命名后刷新共用） */
export async function queryAndRender(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position): Promise<void> {
  fileLinesCache.clear();
  lastStable = true;
  // E-2：引擎未就绪时 references 会静默返回空——「无引用」是误导，必须显式告知（G-3）
  if (getEngineStatus() !== "ready") {
    lastItems = [];
    activeKind = "all";
    renderEmpty(t("ide.fu.engineNotReady"));
    setBottomTab("findUsages");
    return;
  }
  setEngineBusy(true); // E-2：查询期间引擎 chip 显示忙碌态
  let refs: LspReferenceLocation[];
  try {
    // 稳定采样：pyrefly lazy 索引推进期间不落瞬时值（已稳定时只多一次请求）
    refs = await waitReferencesStable(model, position, {
      maxTries: 4,
      intervalMs: 500,
      onSettled: (stable) => {
        lastStable = stable;
      },
    });
  } catch (e) {
    toast(t("ide.fu.failed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : e)) }), "error");
    return;
  } finally {
    setEngineBusy(false);
  }
  if (refs.length === 0) {
    lastItems = [];
    activeKind = "all";
    renderEmpty(lastStable ? t("ide.fu.noRefs") : t("ide.fu.unstableRetry"));
    setBottomTab("findUsages");
    return;
  }
  const items: RefItem[] = [];
  for (const r of refs) {
    const lines = await readLines(r.path);
    const text = lines[r.line - 1] ?? "";
    items.push({ ...r, text, kind: classifyRef({ text, col: r.col, endCol: r.endCol }) });
  }
  lastItems = items;
  activeKind = "all";
  render();
  setBottomTab("findUsages");
}

/** Alt+F7：查询光标处符号的所有引用并落到底部「引用」面板 */
export async function findUsagesAtCursor(): Promise<void> {
  const editor = app.editor;
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) {
    toast(t("ide.fu.noSymbol"), "info");
    return;
  }
  await queryAndRender(model, pos);
}

/** PR-I（dx_features_backlog §6.6）：Ctrl+Shift+双击 = 查找引用（PyCharm 手势对标）。
 *  为什么不用 `editor.onMouseDown`：Monaco 的鼠标事件拿不到「第几次点击」，
 *  而 DOM `dblclick` 天然是双击语义且带修饰键信息——只在**同时按住 Ctrl+Shift** 时接管，
 *  默认双击选词习惯零改变。光标已由双击落在词上，故直接用 position 查询；
 *  点在空白/非词上时不出面板（避免打开一个必然为空的结论）。
 */
/** 双击判定窗口（ms，与 Double Shift 同款量级） */
const DBLCLICK_MS = 400;

/**
 * PR-I（dx_features_backlog §6.6）：Ctrl+Shift+双击 = 查找引用（PyCharm 手势对标）。
 *
 * ⚠ 为什么**不用 DOM `dblclick` 事件**（e2e 探针实测）：Monaco 在两次点击之间会重绘行 DOM
 * （选区变化触发），两次点击的 target 不是同一个节点 → **浏览器不合成 dblclick 事件**
 * （实测：mousedown/mouseup 各 2 次、dblclick 0 次）。真实用户同样踩这个坑，
 * 因此改用 Monaco 的 `onMouseDown` 自行判定「同位置短间隔两次点击」——与 Monaco 内部
 * 判定多击的思路同源，且不依赖 DOM 节点稳定性。
 *
 * 另一处坑：注册时 `editor.getDomNode()` 可能为空/后续被替换，故不缓存 DOM 节点。
 */
export function installCtrlShiftDblclickUsages(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
): MonacoApi.IDisposable {
  let lastAt = 0;
  let lastLine = -1;
  let lastCol = -1;
  return editor.onMouseDown((e) => {
    const p = e.target.position;
    // 只有「按住 Ctrl+Shift + 落在文本位置」才记时；其余情况立即作废计时（防误触累积）
    if (!e.event.ctrlKey || !e.event.shiftKey || !p) {
      lastAt = 0;
      return;
    }
    const now = Date.now();
    const isDouble = now - lastAt < DBLCLICK_MS && p.lineNumber === lastLine && p.column === lastCol;
    lastAt = now;
    lastLine = p.lineNumber;
    lastCol = p.column;
    if (!isDouble) return;
    const model = editor.getModel();
    if (!model || !model.getWordAtPosition(p)?.word) return;
    void queryAndRender(model, p);
  });
}

/** 编辑器右键菜单「查找引用」入口（可发现性；键位仍归键位系统 Alt+F7 管） */
export function initFindUsagesAction(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  return editor.addAction({
    id: "pylume.findUsages",
    label: t("ide.fu.actionLabel"),
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.7,
    run: () => void findUsagesAtCursor(),
  });
}

/** Shift+F6 / 面板按钮：就地重命名光标处符号（ghost 预览 + 多文件 diff 确认，见 renameWidget.ts） */
export async function renameSymbolAtCursor(): Promise<void> {
  await startRenameAtCursor();
}

/** 清空面板与行缓存（工作区切换 / 关闭时调用） */
export function resetFindUsages(): void {
  fileLinesCache.clear();
  lastItems = [];
  activeKind = "all";
  lastStable = true;
  const el = $("find-usages-panel");
  if (el) el.textContent = "";
}