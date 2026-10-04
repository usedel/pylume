// 模板面板（M4，方案 §9.5）：quick pick 当前上下文全部可用插入模板（默认 Ctrl+J，可配置）
// 不记得缩写时的兜底与模板库浏览入口：缩写/描述过滤，方向键/Enter/鼠标选择，光标处插入。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import type { TemplateRegistry } from "./registry";
import type { TemplateDef } from "./schema";
import type { SyntaxContext } from "./scope";
import { compileTemplate } from "./compiler";
import type { EngineContext } from "./engine";
import { insertSnippet } from "./snippet";
import { hideEl, showEl } from "../anim";
import { trapFocus } from "../focusTrap";

/** UI-05：模板面板模态的焦点陷阱解除句柄 */
let releasePaletteFocus: (() => void) | null = null;

export interface PaletteHost {
  buildEngineContext(
    model: MonacoApi.editor.ITextModel,
    position: MonacoApi.Position,
    tpl: TemplateDef,
  ): Promise<EngineContext>;
  resolveScopeInfo(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position): SyntaxContext;
}

/** 注册模板面板（DOM 接线）；快捷键经 keybindings.ts 可配置（template_palette），
 *  由调用方把 open() 接入键位命令，故此处不再自行 addCommand。 */
export function registerPalette(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  registry: TemplateRegistry,
  host: PaletteHost,
): { dispose(): void; open(): void } {
  const modal = document.getElementById("palette-modal");
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closePalette();
  });
  return { dispose: () => undefined, open: () => openPalette(editor, registry, host) };
}

function closePalette(): void {
  const modal = document.getElementById("palette-modal");
  const input = document.getElementById("palette-search") as HTMLInputElement | null;
  releasePaletteFocus?.();
  releasePaletteFocus = null;
  if (modal) hideEl(modal);
  if (input) input.value = "";
}

function openPalette(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  registry: TemplateRegistry,
  host: PaletteHost,
): void {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return;
  const modal = document.getElementById("palette-modal");
  const input = document.getElementById("palette-search") as HTMLInputElement | null;
  const listEl = document.getElementById("palette-list");
  if (!modal || !input || !listEl) return;
  if (!modal.classList.contains("hidden")) return; // 已打开

  const scopeInfo = host.resolveScopeInfo(model, pos);
  const all = registry.templatesForContext(scopeInfo);
  if (all.length === 0) return;

  let filtered: TemplateDef[] = [...all];
  let selected = 0;

  const updateSelected = (): void => {
    Array.from(listEl.children).forEach((el, i) => {
      el.classList.toggle("selected", i === selected);
      if (i === selected) el.scrollIntoView({ block: "nearest" });
    });
  };

  const close = (): void => {
    closePalette();
    editor.focus();
  };

  const apply = async (tpl: TemplateDef): Promise<void> => {
    close();
    // 关闭后以最新光标位置构建上下文并插入（空选区 → 光标处插入）
    const nowPos = editor.getPosition();
    if (editor.getModel() !== model || !nowPos) return;
    const ctx = await host.buildEngineContext(model, nowPos, tpl);
    insertSnippet(editor, compileTemplate(tpl, ctx));
  };

  const render = (): void => {
    listEl.textContent = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "无匹配模板";
      listEl.appendChild(empty);
      return;
    }
    filtered.forEach((tpl, i) => {
      const row = document.createElement("div");
      row.className = "palette-item" + (i === selected ? " selected" : "");
      const abbr = document.createElement("span");
      abbr.className = "palette-abbr";
      abbr.textContent = tpl.abbreviation;
      const desc = document.createElement("span");
      desc.className = "palette-desc";
      desc.textContent = tpl.description;
      row.appendChild(abbr);
      if (tpl.group) {
        const badge = document.createElement("span");
        badge.className = "lt-badge lt-group palette-group";
        badge.textContent = tpl.group;
        row.appendChild(badge);
      }
      row.appendChild(desc);
      row.addEventListener("mouseenter", () => {
        selected = i;
        updateSelected();
      });
      row.addEventListener("click", () => void apply(tpl));
      listEl.appendChild(row);
    });
  };

  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    filtered = q
      ? all.filter(
          (t) => t.abbreviation.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
        )
      : [...all];
    selected = 0;
    render();
  };
  input.onkeydown = (e: KeyboardEvent) => {
    e.stopPropagation(); // 防止落入编辑器/全局快捷键
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
      updateSelected();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
      updateSelected();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const tpl = filtered[selected];
      if (tpl) void apply(tpl);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  render();
  showEl(modal);
  releasePaletteFocus?.();
  releasePaletteFocus = trapFocus(modal);
  input.focus();
}
