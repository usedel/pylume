// 环绕模板（M3，方案 §9.3）：打开选择器（默认 Ctrl+Alt+T，可配置），$SELECTION$ 承载选区
// 选区缩进处理（v1 简单实现）：整体扣最小缩进归一 → 后续行补「起点行缩进 + 模板前缀」。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import type { TemplateRegistry } from "./registry";
import type { TemplateDef } from "./schema";
import type { SyntaxContext } from "./scope";
import { compileTemplate } from "./compiler";
import type { EngineContext } from "./engine";
import { insertSnippet } from "./snippet";
import { hideEl, showEl } from "../anim";
import { trapFocus } from "../focusTrap";

/** UI-05：环绕模板选择器模态的焦点陷阱解除句柄 */
let releaseSurroundFocus: (() => void) | null = null;

export interface SurroundHost {
  buildEngineContext(
    model: MonacoApi.editor.ITextModel,
    position: MonacoApi.Position,
    tpl: TemplateDef,
  ): Promise<EngineContext>;
  resolveScopeInfo(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position): SyntaxContext;
}

/** 模板体中 $SELECTION$ 所在行的空白前缀（该变量在模板内的相对缩进） */
export function selectionLinePrefix(body: string): string {
  for (const line of body.split("\n")) {
    if (line.includes("$SELECTION$")) {
      const m = /^[ \t]*/.exec(line);
      return m ? m[0] : "";
    }
  }
  return "";
}

/**
 * 选区缩进归一与重排：
 * - 选区从行首（首个非空白字符处或之前）开始：各非空行扣除最小缩进归一，
 *   首行由模板 $SELECTION$ 位置定位不补缩进，后续行补 baseIndent + templatePrefix；
 * - 选区从行中开始：后续行的绝对缩进本就相对选取点格式化 → 原样保留（v1）；
 * - 空行保持空。
 */
export function prepareSelectionIndent(
  text: string,
  baseIndent: string,
  templatePrefix: string,
  selectionStartsAtLineHead: boolean,
): string {
  const lines = text.split("\n");
  if (lines.length === 1) return text;
  if (!selectionStartsAtLineHead) return text;
  let minIndent = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    minIndent = Math.min(minIndent, l.length - l.trimStart().length);
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  const pad = baseIndent + templatePrefix;
  return lines
    .map((l, idx) => {
      if (!l.trim()) return "";
      const own = l.length - l.trimStart().length;
      const dedented = l.slice(Math.min(minIndent, own));
      return idx === 0 ? dedented : pad + dedented;
    })
    .join("\n");
}

/** 注册环绕模板；快捷键经 keybindings.ts 可配置（surround），
 *  由调用方把 open() 接入键位命令，故此处不再自行 addCommand。 */
export function registerSurround(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  registry: TemplateRegistry,
  host: SurroundHost,
): { dispose(): void; open(): void } {
  return {
    dispose: () => undefined,
    open: () => void openSurroundPicker(editor, registry, host),
  };
}

async function openSurroundPicker(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  registry: TemplateRegistry,
  host: SurroundHost,
): Promise<void> {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel || sel.isEmpty()) return;

  const scopeInfo = host.resolveScopeInfo(model, sel.getStartPosition());
  const templates = registry.findSurround(`python:${scopeInfo.syntax}`);
  if (templates.length === 0) return;

  const modal = document.getElementById("surround-modal");
  const listEl = document.getElementById("surround-list");
  if (!modal || !listEl) return;

  listEl.textContent = "";
  const close = (): void => {
    releaseSurroundFocus?.();
    releaseSurroundFocus = null;
    hideEl(modal);
    window.removeEventListener("keydown", onKey, true);
  };
  // UI-02：头部关闭按钮（onclick 赋值而非 addEventListener，重复打开不会叠加监听）
  const closeBtn = document.getElementById("surround-close");
  if (closeBtn) closeBtn.onclick = close;
  const apply = (tpl: TemplateDef): void => {
    close();
    void applySurround(editor, tpl, sel, host);
  };

  templates.forEach((tpl, i) => {
    const row = document.createElement("div");
    row.className = "surround-item";
    const num = document.createElement("span");
    num.className = "surround-num";
    num.textContent = String(i + 1);
    const name = document.createElement("span");
    name.className = "surround-name";
    name.textContent = tpl.abbreviation;
    const desc = document.createElement("span");
    desc.className = "surround-desc";
    desc.textContent = tpl.description;
    row.append(num, name, desc);
    row.addEventListener("click", () => apply(tpl));
    listEl.appendChild(row);
  });

  // capture 阶段拦截：数字键选择 / Esc 关闭，避免按键落入编辑器
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= templates.length) {
      e.preventDefault();
      e.stopPropagation();
      apply(templates[n - 1]);
    }
  };
  window.addEventListener("keydown", onKey, true);
  modal.addEventListener(
    "click",
    (e) => {
      if (e.target === modal) close();
    },
    { once: true },
  );
  showEl(modal);
  releaseSurroundFocus?.();
  releaseSurroundFocus = trapFocus(modal);
}

async function applySurround(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  tpl: TemplateDef,
  sel: MonacoApi.Selection,
  host: SurroundHost,
): Promise<void> {
  const model = editor.getModel();
  if (!model) return;
  const text = model.getValueInRange(sel);
  if (!text) return;

  const startLine = model.getLineContent(sel.startLineNumber);
  const baseIndent = (/^[ \t]*/.exec(startLine) ?? [""])[0];
  // 选区起点位于行首（首个非空白字符处或之前）→ 走归一重排；行中选取 → 保留原缩进
  const atLineHead = sel.startColumn - 1 <= baseIndent.length;
  const prepared = prepareSelectionIndent(
    text,
    baseIndent,
    selectionLinePrefix(tpl.body),
    atLineHead,
  );

  const ctx = await host.buildEngineContext(model, sel.getStartPosition(), tpl);
  // await 期间选区可能变化：校验后再替换
  const nowSel = editor.getSelection();
  if (editor.getModel() !== model || !nowSel || !nowSel.equalsRange(sel)) return;

  const snippet = compileTemplate(tpl, ctx, { SELECTION: prepared });
  editor.setSelection(sel);
  if (!insertSnippet(editor, snippet)) {
    editor.trigger("keyboard", "tab", null); // 贡献缺失兜底：不吞键
  }
}
