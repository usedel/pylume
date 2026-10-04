// 就地重命名（P0，对标 PyCharm in-place rename）：
//
// - prepareRename 锚定符号（光标落在注释 / 字符串上给提示，不盲改）；
// - 标识符原地渲染输入框（content widget），当前文件引用位置 ghost 高亮预览；
// - Enter 确认：单文件改动直接写入（零摩擦）；跨文件改动弹出确认摘要
//   「影响 N 个文件 + 各文件命中数」（D-3，2026-09-25 立项）——不展示逐处 diff
//   （原用户决策「不做 diff 预览模态」仍有效），跨文件回滚依赖 Git / 本地历史。
//
// LSP 数据层（锚定 / 请求编辑集 / 应用编辑集）在 lsp/client.ts；本模块只做交互。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { app } from "./state";
import {
  fetchRenameAnchor,
  fetchRenameChanges,
  applyRenameChanges,
  fetchReferencesAt,
  waitReferencesStable,
  modelPath,
  type RenameFileEdits,
  type LspReferenceLocation,
} from "./lsp/client";
import { relativePathOrName, samePath } from "./util";
import { isPydanticFieldDecl } from "./pydanticField";
import { toast, toastFail } from "./toast";
import { openConfirm } from "./dialog";
import { setEngineBusy } from "./engineChip";
import { t } from "./i18n"; // 第十二批 i18n：重命名动态文案走语言包

// ---------- 就地改名 widget（editor content widget） ----------

let active = false; // 防重入（连按 Shift+F6 / F2）
let anchor: MonacoApi.Range | null = null;
let widgetModel: MonacoApi.editor.ITextModel | null = null;
let contentWidget: MonacoApi.editor.IContentWidget | null = null;
let inputEl: HTMLInputElement | null = null;
let countEl: HTMLElement | null = null;
let editorKeys: MonacoApi.IDisposable | null = null;
let ghostDecorations: string[] = [];
let localRefCount = 0;
let crossFileCount = 0;
/** E-2：引用索引是否稳定（false → 提示条与落地后 toast 都会告知「可能不完整」） */
let refsUnstable = false;

function closeWidget(): void {
  active = false;
  editorKeys?.dispose();
  editorKeys = null;
  if (contentWidget) {
    app.editor.removeContentWidget(contentWidget);
    contentWidget = null;
  }
  if (widgetModel && !widgetModel.isDisposed() && ghostDecorations.length > 0) {
    widgetModel.deltaDecorations(ghostDecorations, []);
  }
  ghostDecorations = [];
  widgetModel = null;
  anchor = null;
  inputEl = null;
  countEl = null;
  localRefCount = 0;
  crossFileCount = 0;
}

/** 当前文件引用 ghost 高亮（含定义本身；多行范围跳过） */
async function loadGhostPreview(model: MonacoApi.editor.ITextModel, path: string): Promise<void> {
  const start = anchor?.getStartPosition();
  if (!start) return;
  let refs: LspReferenceLocation[] = [];
  try {
    refs = await fetchReferencesAt(model, start);
  } catch {
    return;
  }
  if (!active || widgetModel !== model || anchor === null) return; // 会话已结束
  applyGhost(model, path, refs);
}

/** 用引用采样结果刷新 ghost 装饰与提示条计数（索引稳定轮询期间反复调用） */
function applyGhost(model: MonacoApi.editor.ITextModel, path: string, refs: LspReferenceLocation[]): void {
  if (!active || widgetModel !== model || anchor === null) return; // 会话已结束
  const decorable = refs.filter((r) => samePath(r.path, path) && r.endLine === r.line);
  localRefCount = decorable.length;
  crossFileCount = new Set(refs.filter((r) => !samePath(r.path, path)).map((r) => r.path)).size;
  const decos = decorable.map((r) => ({
    range: new app.monaco.Range(r.line, r.col, r.endLine, r.endCol),
    options: { inlineClassName: "oc-rename-ghost" },
  }));
  ghostDecorations = model.deltaDecorations(ghostDecorations, decos);
  updateHint();
}

function updateHint(): void {
  if (!countEl) return;
  const base =
    crossFileCount > 0
      ? t("editor.rename.localAndCross", { local: localRefCount, cross: crossFileCount })
      : t("editor.rename.localOnly", { local: localRefCount });
  // E-2：索引未稳定时显式告知（G-3 禁止静默不完整）
  countEl.textContent = refsUnstable ? t("editor.rename.unstableSuffix", { base: base }) : base;
}

function buildWidget(): void {
  const host = document.createElement("div");
  host.className = "oc-rename-widget";
  const input = document.createElement("input");
  input.className = "oc-rename-input";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", t("editor.rename.inputAria"));
  const hint = document.createElement("div");
  hint.className = "oc-rename-hint";
  const count = document.createElement("span");
  count.className = "oc-rename-hint-count";
  count.textContent = t("editor.rename.counting");
  const keys = document.createElement("span");
  keys.textContent = t("editor.rename.keysHint");
  hint.append(count, keys);
  host.append(input, hint);
  inputEl = input;
  countEl = count;

  const widget: MonacoApi.editor.IContentWidget = {
    getId: () => "pylume.renameWidget",
    getDomNode: () => host,
    getPosition: () => {
      if (!anchor) return null;
      return {
        position: anchor.getStartPosition(),
        preference: [app.monaco.editor.ContentWidgetPositionPreference.BELOW, app.monaco.editor.ContentWidgetPositionPreference.ABOVE],
      };
    },
  };
  contentWidget = widget;
  app.editor.addContentWidget(widget);

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void confirmRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeWidget();
      app.editor.focus();
    }
  });
  // 焦点在编辑器时（点回正文）按 Esc 也能收起
  editorKeys = app.editor.onKeyDown((e) => {
    if (e.keyCode === app.monaco.KeyCode.Escape) {
      closeWidget();
      app.editor.focus();
    }
  });
}

/** 阶段 2 · Pydantic 字段改名提示的会话去重键 = 工作区 + "pydantic_rename"
 * （每工作区每会话最多一次；Set 随应用生命周期存在，规模 = 打开过的工作区数，
 * 关闭工作区由 main 调 resetPydanticRenameWarn 清空——与旧 pydanticEngineHint 同款模式） */
const pydanticRenameWarned = new Set<string>();

/** 阶段 2 · 显式化短板：重命名 Pydantic 字段前 toast 提示「pyrefly 不传播构造调用处引用」。
 *  仅当前引擎为 pyrefly（含缺省回退）且 anchor 命中 BaseModel 子类字段声明时提示。 */
function warnPydanticFieldRename(model: MonacoApi.editor.ITextModel, range: MonacoApi.Range): void {
  if ((app.settings.lsp_engine || "pyrefly") !== "pyrefly") return; // basedpyright 下不提示
  const all = model.getValue().split("\n");
  if (!isPydanticFieldDecl(all, range.startLineNumber - 1, range.startColumn - 1)) return;
  // 去重置位放在命中判定之后：普通符号的 rename 不得消耗本工作区的唯一提示机会
  const root = app.workspaceRoot;
  if (root) {
    const key = `${root}#pydantic_rename`;
    if (pydanticRenameWarned.has(key)) return;
    pydanticRenameWarned.add(key);
  }
  toast(t("editor.rename.pydanticToast"), "info");
}

/** 关闭工作区时清空会话去重（main 的 clearRunProfilesCache 调用点旁） */
export function resetPydanticRenameWarn(): void {
  pydanticRenameWarned.clear();
}

async function startSession(): Promise<void> {
  const ed = app.editor;
  const model = ed.getModel();
  const pos = ed.getPosition();
  if (!model || !pos) {
    toast(t("editor.rename.noSymbol"), "info");
    return;
  }
  const path = modelPath(model);
  if (!path) {
    toast(t("editor.rename.noSymbol"), "info");
    return;
  }
  let a = await fetchRenameAnchor(model, pos);
  if (!a) {
    const word = model.getWordAtPosition(pos);
    if (word) {
      a = { range: new app.monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn), placeholder: word.word };
    }
  }
  if (!a) {
    toast(t("editor.rename.notRenamable"), "info");
    return;
  }
  // 阶段 2 · 显式化短板：pyrefly 不传播 Pydantic 字段构造调用处引用（F0 实测 references=0），
  // rename BaseModel 子类字段前提示「可能只改声明处」，避免静默漏改（每工作区每会话一次）
  warnPydanticFieldRename(model, a.range);
  active = true;
  anchor = a.range;
  widgetModel = model;
  refsUnstable = false; // E-2：新会话重置稳定性
  buildWidget();
  ed.revealRange(a.range);
  // 预填当前符号名并全选（对齐 PyCharm：直接键入即整体替换）
  if (inputEl) inputEl.value = model.getValueInRange(a.range);
  inputEl?.focus();
  inputEl?.select();
  void loadGhostPreview(model, path);
}

/** Shift+F6 / F2 / 引用面板「重命名」统一入口 */
export async function startRenameAtCursor(): Promise<void> {
  if (active) return;
  await startSession();
}

/** Pydantic 字段改名传播补充（阶段 4 子项 2b）：
 *  anchor 命中 BaseModel 子类字段时，向 Rust 按需扫描 `Model(field=` 构造调用点，
 *  把引擎未覆盖的引用追加进 edits（同位置去重，引擎结果优先）；扫描超时/失败静默降级
 *  ——rename 本身已有 diff 确认与「可能不完整」提示兜底，不打扰用户。 */
async function supplementPydanticCtorRefs(
  model: MonacoApi.editor.ITextModel,
  anchorRange: MonacoApi.Range,
  oldName: string,
  newName: string,
  files: RenameFileEdits[],
): Promise<RenameFileEdits[]> {
  const root = app.workspaceRoot;
  if (!root || app.settings.pydantic_diagnostics === false) return files;
  if ((app.settings.lsp_engine || "pyrefly") !== "pyrefly") return files; // basedpyright 自己会传播
  // 复用阶段 2 的识别：非 BaseModel 字段 rename 不走补充
  const all = model.getValue().split("\n");
  if (!isPydanticFieldDecl(all, anchorRange.startLineNumber - 1, anchorRange.startColumn - 1)) return files;
  const model_name = pydanticModelNameOf(all, anchorRange.startLineNumber - 1);
  if (!model_name) return files;
  let refs: { file: string; line: number; column: number; len: number }[];
  try {
    refs = await withTimeout(
      invoke<{ file: string; line: number; column: number; len: number }[]>("scan_pydantic_ctor_refs", {
        root,
        model: model_name,
        field: oldName,
      }),
      2000,
    );
  } catch {
    return files; // 超时 / 失败：降级为纯引擎结果
  }
  if (refs.length === 0) return files;
  return mergeCtorRefsIntoFiles(files, refs, newName);
}

/** 纯函数（vitest 直测）：把 `Model(field=` 补充点合并进引擎 edits——
 *  同位置（normPath + 行 + 列）去重，引擎结果优先；补充点宽度 = 字段名长度。 */
export function mergeCtorRefsIntoFiles(
  files: RenameFileEdits[],
  refs: { file: string; line: number; column: number; len: number }[],
  newName: string,
): RenameFileEdits[] {
  const engineKeys = new Set(
    files.flatMap((f) => f.edits.map((e) => `${normPathOf(f.path)}#${e.startLine}#${e.startColumn}`)),
  );
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  for (const r of refs) {
    const key = `${normPathOf(r.file)}#${r.line}#${r.column}`;
    if (engineKeys.has(key)) continue;
    let entry = byPath.get(r.file);
    if (!entry) {
      entry = { path: r.file, edits: [] };
      byPath.set(r.file, entry);
    }
    entry.edits.push({
      startLine: r.line,
      startColumn: r.column,
      endLine: r.line,
      endColumn: r.column + r.len,
      text: newName,
    });
  }
  return [...byPath.values()].filter((f) => f.edits.length > 0);
}

/** 行号向上找所属模型类名：沿继承链向上直到 BaseModel（子类字段 rename 也能定位——
 *  `class Admin(User)` 自有字段向上第一跳不是 BaseModel，须继续沿 bases 找到链头）。
 *  返回**起点类**（字段真正所属的类），不是链头；链上任何祖先是 BaseModel 即认。
 *  同文件继承链（跨文件继承是已知边界）。导出供单测。 */
export function pydanticModelNameOf(lines: string[], line: number): string | null {
  const CLASS_RE = /^\s*class\s+([A-Za-z_]\w*)\s*\((.*)\)\s*:/;
  const PLAIN_CLASS_RE = /^\s*class\s+([A-Za-z_]\w*)\s*:/; // 无基类形态（普通类边界）
  const findClass = (name: string): string | null => {
    const re = new RegExp(`^\\s*class\\s+${name}\\s*\\((.*)\\)\\s*:`);
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m[1];
    }
    return null;
  };
  // 1) 从字段行向上找最近的带括号类声明（起点）
  let cur: { name: string; bases: string } | null = null;
  for (let i = line; i >= 0 && i >= line - 200; i--) {
    if (PLAIN_CLASS_RE.test(lines[i] ?? "")) return null; // 无基类普通类：终点边界
    const m = CLASS_RE.exec(lines[i] ?? "");
    if (m) {
      cur = { name: m[1], bases: m[2] };
      break;
    }
  }
  if (!cur) return null;
  const startName = cur.name;
  // 2) 沿继承链向上：任一祖先是 BaseModel → 起点类就是模型
  let hops = 0;
  while (hops < 10) {
    const baseNames: string[] = cur.bases
      .split(",")
      .map((s) => s.trim().split(".").pop() ?? "")
      .filter(Boolean);
    if (baseNames.includes("BaseModel")) return startName;
    const nextName = baseNames.find((b) => findClass(b) !== null);
    if (nextName === undefined) return null; // 全链找不到声明（跨文件/普通类）→ 边界
    const nextBases = findClass(nextName);
    if (nextBases === null) return null;
    cur = { name: nextName, bases: nextBases };
    hops++;
  }
  return null;
}

function normPathOf(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Promise 超时包装（超时 reject；不 abort 底层 invoke——Rust 扫描毫秒级，迟到结果被丢弃即可） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { window.clearTimeout(t); resolve(v); },
      (e) => { window.clearTimeout(t); reject(e); },
    );
  });
}

// ---------- 确认与应用 ----------

let afterRename: (() => void) | null = null;
/** 重命名落盘后的刷新钩子（main.ts 注入：刷新引用面板） */
export function setAfterRenameHandler(fn: () => void): void {
  afterRename = fn;
}

/** 摘要明细的文件数上限（G-1：大工作区跨文件改名不刷出无界列表，超出折叠计数） */
const SUMMARY_MAX_FILES = 10;

/** 纯函数（vitest 直测）：跨文件确认摘要——按命中数降序的「文件 × 处数」明细。
 *  路径展示走 relativePathOrName（工作区内相对路径，越界回落文件名）。 */
export function summarizeRenameTargets(
  files: RenameFileEdits[],
  root: string | null,
  maxFiles = SUMMARY_MAX_FILES,
): { total: number; lines: string[] } {
  const total = files.reduce((n, f) => n + f.edits.length, 0);
  const sorted = [...files].sort((a, b) => b.edits.length - a.edits.length);
  const lines = sorted
    .slice(0, maxFiles)
    .map((f) => t("editor.rename.fileLine", { path: relativePathOrName(root, f.path), count: f.edits.length }));
  if (sorted.length > maxFiles) lines.push(t("editor.rename.moreFiles", { count: sorted.length - maxFiles }));
  return { total, lines };
}

async function confirmRename(): Promise<void> {
  const model = widgetModel;
  const a = anchor;
  const input = inputEl;
  if (!model || !a || !input) return;
  const newName = input.value.trim();
  if (!newName) return;
  if (!/^[A-Za-z_]\w*$/.test(newName)) {
    input.classList.add("is-invalid");
    toast(t("editor.rename.invalidName"), "info");
    return;
  }
  const currentName = model.getValueInRange(a);
  if (newName === currentName) {
    closeWidget();
    app.editor.focus();
    return;
  }
  const start = a.getStartPosition();
  // pyrefly lsp 默认 lazy 索引（打开首文件后才后台建索引）：不等索引稳定就发 rename
  // 只会覆盖已索引文件 → 漏改。先轮询 references 直到连续两次全等（期间实时刷 ghost 计数），
  // 已稳定时只多一次请求（毫秒级）。
  const path = modelPath(model);
  refsUnstable = false;
  setEngineBusy(true); // E-2：稳定采样期间引擎 chip 显示忙碌态
  try {
    await waitReferencesStable(model, start, {
      onSample: (refs) => {
        if (path) applyGhost(model, path, refs);
      },
      onSettled: (stable) => {
        refsUnstable = !stable;
      },
    });
  } finally {
    setEngineBusy(false);
  }
  updateHint(); // E-2：稳定结果落地后刷新提示（含未稳定警示）
  let files: RenameFileEdits[];
  try {
    files = await fetchRenameChanges(model, start, newName);
  } catch (e) {
    toastFail(t("editor.rename.failAction"), e);
    return;
  }
  // 阶段 4 子项 2b：Pydantic 字段改名传播补充——pyrefly 对 BaseModel 字段 references=0
  // （只改声明处），此处用 AST 文本扫描补 `Model(field=` 调用点（engine 结果优先，去重合并）。
  files = await supplementPydanticCtorRefs(model, a, currentName, newName, files);
  if (files.length === 0) {
    toast(t("editor.rename.noChanges"), "info");
    return;
  }
  // D-3：跨文件改动显式确认（影响面可见再落盘）；当前文件内改动保持 Enter 即应用（零摩擦）
  const crossFile = path !== null && files.some((f) => !samePath(f.path, path));
  if (crossFile) {
    const { total, lines } = summarizeRenameTargets(files, app.workspaceRoot);
    const ok = await openConfirm({
      title: t("editor.rename.crossTitle", { from: currentName, to: newName }),
      // 确认语多段拼装（跨行模板 + \n\n 不走 apply_ts 映射，避免语言包转义链失真），按段取词
      message: `${t("editor.rename.crossSummary", { files: files.length, total: total })}\n${lines.join("\n")}${
        refsUnstable ? `\n\n${t("editor.rename.unstableNote")}` : ""
      }`,
      okLabel: t("editor.rename.okAll"),
      kind: "primary",
    });
    if (!ok) {
      closeWidget();
      app.editor.focus();
      return;
    }
  }
  closeWidget();
  app.editor.focus();
  try {
    await applyRenameChanges(model, files);
    const total = files.reduce((n, f) => n + f.edits.length, 0);
    toast(t("editor.rename.done", { from: currentName, to: newName, files: files.length, total: total }), "success");
    if (refsUnstable) {
      // E-2：索引未稳定时落地的重命名可能漏改未打开文件——显式提醒复查（G-3）
      toast(t("editor.rename.unstableToast"), "info");
    }
    afterRename?.();
  } catch (e) {
    toastFail(t("editor.rename.failAction"), e);
  }
}

// ---------- 初始化 ----------

/** F2 / Shift+F6 就地改名 + 编辑器右键菜单「重命名…」入口（可发现性） */
export function initRenameWidget(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  editor.addCommand(app.monaco.KeyCode.F2, () => void startRenameAtCursor());
  return editor.addAction({
    id: "pylume.rename",
    label: t("editor.rename.paletteLabel"),
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.6,
    run: () => void startRenameAtCursor(),
  });
}
