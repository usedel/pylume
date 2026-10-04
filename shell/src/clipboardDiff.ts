// 与剪贴板对比（C-5，PyCharm 调研 §6-C-5）：当前文件 / 选区 vs 剪贴板，Monaco diff 模态呈现。
//
// 刻意不复用 git.ts 的 diff 宿主：那套状态机（三态基准 / 冲突开关 / hunk 列表）与仓库语义
// 深度耦合，剪贴板 diff 只需要「两侧文本 + 只读展示」。独立懒创建 diff 编辑器实例，
// 关闭时释放两侧 model（G-1：不累积），实例本身复用。
//
// 入口：编辑器右键「与剪贴板对比」（有选区比选区，无选区比整个文件）+ 文件树右键（整个文件）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { app, lazyEl } from "./state";
import { languageOf } from "./util";
import { hideEl, motionDisabled, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { toast } from "./toast";
import { readClipboardText } from "./devtools/host";
import { t } from "./i18n"; // 第十三批 i18n：动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { errMsg } from "./util";

const modalEl = lazyEl("clipboard-diff-modal");
const hostEl = lazyEl("clipboard-diff-host");
const titleEl = lazyEl("clipboard-diff-title");

let diffEditor: MonacoApi.editor.IStandaloneDiffEditor | null = null;
let originalModel: MonacoApi.editor.ITextModel | null = null;
let modifiedModel: MonacoApi.editor.ITextModel | null = null;
let releaseFocus: (() => void) | null = null;
let wired = false;

/** 关闭按钮接线（首次打开时一次） */
function wireOnce(): void {
  if (wired) return;
  wired = true;
  lazyEl<HTMLButtonElement>("clipboard-diff-close").addEventListener("click", closeClipboardDiff);
}

/** Esc 关闭（模态打开期间挂 document；有多层模态时归最上层——对齐 settingsPanel 守卫） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (document.querySelectorAll(".modal:not(.hidden)").length > 1) return;
  closeClipboardDiff();
}

function closeClipboardDiff(): void {
  document.removeEventListener("keydown", onKeydown);
  releaseFocus?.();
  releaseFocus = null;
  hideEl(modalEl);
  // 先复位（setModel(null) = 解绑两侧 model，Monaco 0.52 契约：TextModel 不得先于复位释放）
  diffEditor?.setModel(null);
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
}

function fileLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 打开对比：`text`（当前文件/选区内容）vs 剪贴板文本；`langPath` 供语言推断（可缺省） */
export async function openClipboardDiff(text: string, label: string, langPath?: string): Promise<void> {
  const clip = await readClipboardText();
  if (!clip) {
    toast(t("ide.cd.clipboardEmpty"), "info");
    return;
  }
  titleEl.textContent = t("ide.cd.title", { label: label });
  wireOnce();
  if (!diffEditor) {
    diffEditor = app.monaco.editor.createDiffEditor(hostEl, {
      automaticLayout: true,
      theme: app.settings.theme,
      readOnly: true,
      renderSideBySide: true,
      fontSize: app.settings.font_size,
      // UI-11：光标闪烁随「减少动画」。实例懒创建后长期复用，每次取用重设一次
      cursorBlinking: motionDisabled() ? "solid" : "blink",
    });
  }
  // 先挂新 model 再释旧（旧 model 在 setModel 复位前 dispose 会触发 Monaco 的
  // "TextModel got disposed before DiffEditorWidget model got reset" 错误）
  const newOriginal = app.monaco.editor.createModel(clip, "plaintext");
  const newModified = app.monaco.editor.createModel(text, languageOf(langPath ?? label));
  diffEditor.setModel({ original: newOriginal, modified: newModified });
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = newOriginal;
  modifiedModel = newModified;
  showEl(modalEl);
  releaseFocus?.(); // 防御性先解除（对齐 settingsPanel）
  releaseFocus = trapFocus(modalEl);
  document.addEventListener("keydown", onKeydown);
}

/** 编辑器入口：有选区比选区，无选区比整个文件 */
export async function diffEditorWithClipboard(): Promise<void> {
  const ed = app.editor;
  const model = ed.getModel();
  if (!model) return;
  const sel = ed.getSelection();
  const hasSel = !!sel && !sel.isEmpty();
  const text = hasSel ? model.getValueInRange(sel!) : model.getValue();
  const tabPath = app.activeTab && app.activeTab.kind !== "diff" ? app.activeTab.path : undefined;
  const label = hasSel ? t("ide.cd.selection") : (tabPath ? fileLabel(tabPath) : t("ide.cd.currentFile"));
  await openClipboardDiff(text, label, tabPath);
}

/** 读取工作区文件全文并对比（文件树右键入口；读不到给可见提示——G-3 禁止静默失败） */
export async function diffFileWithClipboard(path: string): Promise<void> {
  let content: string;
  try {
    content = await invoke<string>("read_file", { path });
  } catch (e) {
    toast(t("ide.cd.readFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }), "error");
    return;
  }
  await openClipboardDiff(content, fileLabel(path), path);
}

/** 编辑器右键菜单「与剪贴板对比」（可发现性；有选区比选区） */
export function initClipboardDiffAction(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  return editor.addAction({
    id: "pylume.diffWithClipboard",
    label: t("ide.cd.actionLabel"),
    contextMenuGroupId: "9_cutcopypaste",
    contextMenuOrder: 1.5,
    run: () => void diffEditorWithClipboard(),
  });
}
