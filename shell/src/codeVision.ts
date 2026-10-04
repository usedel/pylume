// 引用计数 Code Vision（P0，对标 PyCharm / JetBrains Code Vision）：
//
// - 类 / 函数 / 方法声明行上方显示「N 处引用」CodeLens（documentSymbol 定位符号，
//   references 计数惰性 resolve——只对可见 lens 发请求）；
// - 点击 lens 弹出轻量引用列表（content widget，不离开编辑器），条目 = 文件:行 + 行预览，
//   点击跳转并选中标识符（与引用面板同一条 openRef 链路）；
// - documentSymbol 按模型版本缓存；内容变更 800ms 防抖后刷新计数。
// 引用面板完整视图仍由 Alt+F7（findUsages.ts）承载；lens 弹层底部提供跳转入口。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app } from "./state";
import {
  documentSymbols,
  waitReferencesStable,
  modelPath,
  type LspDocumentSymbol,
  type LspReferenceLocation,
} from "./lsp/client";
import { relativePathOrName, DisposableStore } from "./util";
import { t } from "./i18n"; // 第十二批 i18n：引用 CodeLens 动态文案走语言包
import { findUsagesAtCursor, openRef, readRefLines } from "./findUsages";

/** 出 lens 的符号种类：Class(5) / Method(6) / Function(12) */
const LENS_KINDS = new Set([5, 6, 12]);

interface LensSymbol {
  line: number;
  col: number;
  name: string;
}

function collectSymbols(list: LspDocumentSymbol[], out: LensSymbol[]): void {
  for (const s of list) {
    if (LENS_KINDS.has(s.kind)) {
      const start = s.selectionRange.start;
      out.push({ line: start.line + 1, col: start.character + 1, name: s.name });
    }
    if (s.children) collectSymbols(s.children, out);
  }
}

// ---------- 引用弹层（content widget） ----------

let popupWidget: MonacoApi.editor.IContentWidget | null = null;
let popupKeys: MonacoApi.IDisposable | null = null;
let popupOutside: ((e: MouseEvent) => void) | null = null;

function closePopup(): void {
  popupKeys?.dispose();
  popupKeys = null;
  if (popupOutside) {
    document.removeEventListener("mousedown", popupOutside);
    popupOutside = null;
  }
  if (popupWidget) {
    app.editor.removeContentWidget(popupWidget);
    popupWidget = null;
  }
}

function buildRow(ref: LspReferenceLocation, text: string, workspaceRoot: () => string | null): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "oc-cv-row";
  const loc = document.createElement("span");
  loc.className = "oc-cv-row-loc";
  loc.textContent = `${relativePathOrName(workspaceRoot(), ref.path)}:${ref.line}`;
  loc.title = ref.path;
  const snippet = document.createElement("span");
  snippet.className = "oc-cv-row-text";
  const start = Math.max(0, ref.col - 1 - 24);
  snippet.textContent = text.slice(start, start + 80).trim() || "…";
  row.append(loc, snippet);
  row.addEventListener("click", () => {
    closePopup();
    openRef(ref);
  });
  return row;
}

async function showUsagesPopup(line: number, col: number): Promise<void> {
  const ed = app.editor;
  const model = ed.getModel();
  if (!model) return;
  closePopup();
  const pos = new app.monaco.Position(line, col);
  const symbolName = model.getWordAtPosition(pos)?.word ?? "";
  // 稳定采样（同 lens）：后台索引推进期间不弹瞬时值
  const refs = await waitReferencesStable(model, pos, { maxTries: 3, intervalMs: 500 });

  const host = document.createElement("div");
  host.className = "oc-cv-popup";
  const header = document.createElement("div");
  header.className = "oc-cv-popup-header";
  header.textContent = symbolName ? t("editor.vision.namedRefs", { name: symbolName, count: refs.length }) : t("editor.vision.refs", { count: refs.length });
  host.appendChild(header);

  if (refs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "oc-cv-popup-empty";
    empty.textContent = t("editor.vision.noRefs");
    host.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "oc-cv-popup-list";
    const shown = refs.slice(0, 50);
    for (const r of shown) {
      const lines = await readRefLines(r.path);
      list.appendChild(buildRow(r, lines[r.line - 1] ?? "", () => app.workspaceRoot));
    }
    if (refs.length > shown.length) {
      const more = document.createElement("div");
      more.className = "oc-cv-popup-more-count";
      more.textContent = t("editor.vision.more", { count: refs.length - shown.length });
      list.appendChild(more);
    }
    host.appendChild(list);
    const footer = document.createElement("button");
    footer.type = "button";
    footer.className = "oc-cv-popup-footer";
    footer.textContent = t("editor.vision.viewAll");
    footer.addEventListener("click", () => {
      closePopup();
      ed.setPosition(pos);
      ed.focus();
      void findUsagesAtCursor();
    });
    host.appendChild(footer);
  }

  popupWidget = {
    getId: () => "pylume.codeVisionPopup",
    getDomNode: () => host,
    getPosition: () => ({
      position: pos,
      preference: [app.monaco.editor.ContentWidgetPositionPreference.BELOW, app.monaco.editor.ContentWidgetPositionPreference.ABOVE],
    }),
  };
  ed.addContentWidget(popupWidget);
  // Esc / 点击弹层外收起（换文件收起由 initCodeVision 里的 onDidChangeModel 统一处理）
  popupKeys = ed.onKeyDown((e) => {
    if (e.keyCode === app.monaco.KeyCode.Escape) {
      closePopup();
      ed.focus();
    }
  });
  popupOutside = (e) => {
    if (popupWidget && !host.contains(e.target as Node)) closePopup();
  };
  document.addEventListener("mousedown", popupOutside);
}

// ---------- CodeLens provider ----------

interface LensCache {
  uri: string;
  version: number;
  symbols: LensSymbol[];
}

let cache: LensCache | null = null;
let refreshFn: (() => void) | null = null;

/** 清缓存并立即刷新 lens（重命名落盘后由 main 延迟调用，等引擎重索引完拿新计数） */
export function refreshCodeVision(): void {
  cache = null;
  refreshFn?.();
}

async function symbolsFor(model: MonacoApi.editor.ITextModel): Promise<LensSymbol[]> {
  const uri = model.uri.toString();
  const version = model.getVersionId();
  if (cache && cache.uri === uri && cache.version === version) return cache.symbols;
  const path = modelPath(model);
  const roots = path ? await documentSymbols(path) : [];
  const symbols: LensSymbol[] = [];
  collectSymbols(roots, symbols);
  cache = { uri, version, symbols };
  return symbols;
}

export function initCodeVision(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  const store = new DisposableStore();
  const commandId = editor.addCommand(0, (_ctx, line: number, col: number) => {
    void showUsagesPopup(line, col);
  });

  // 手写微型 emitter（Monaco 公开 API 不导出 Emitter）：模型内容变更 → 防抖刷新 lens。
  // IEvent 载荷类型是 provider 本身，这里只作通知用。
  let listeners: Array<(e: MonacoApi.languages.CodeLensProvider) => void> = [];
  let fireTimer = 0;
  const fire = (): void => {
    window.clearTimeout(fireTimer);
    fireTimer = window.setTimeout(() => {
      for (const l of listeners) l(provider);
    }, 800);
  };
  const onDidChange = (l: (e: MonacoApi.languages.CodeLensProvider) => void): MonacoApi.IDisposable => {
    listeners.push(l);
    return { dispose: () => (listeners = listeners.filter((x) => x !== l)) };
  };

  // 计数自校正：pyrefly lsp 是 lazy 索引，resolve 拿到的计数会随后台索引推进而变化。
  // 某符号计数与上次不同 → 2s 后再刷一轮，直到收敛（每次变化都会再调度）。
  const lastCounts = new Map<string, number>();
  let stableTimer = 0;
  const scheduleStableRefresh = (): void => {
    window.clearTimeout(stableTimer);
    stableTimer = window.setTimeout(() => {
      for (const l of listeners) l(provider);
    }, 2000);
  };

  const provider: MonacoApi.languages.CodeLensProvider = {
    onDidChange,
    async provideCodeLenses(model) {
      const symbols = await symbolsFor(model);
      return {
        lenses: symbols.map((s) => ({
          range: {
            startLineNumber: s.line,
            startColumn: s.col,
            endLineNumber: s.line,
            endColumn: s.col,
          },
        })),
        dispose: () => undefined,
      };
    },
    async resolveCodeLens(model, lens) {
      const pos = new app.monaco.Position(lens.range.startLineNumber, lens.range.startColumn);
      let count = 0;
      try {
        // 稳定双采样：pyrefly 后台索引 / didOpen 重验证期间计数会瞬时回落，
        // 直接显示会「变少一会又变多」——连续两次一致才上屏（已稳定时只多一次请求）
        const refs = await waitReferencesStable(model, pos, { maxTries: 3, intervalMs: 500 });
        count = refs.length;
      } catch {
        count = 0;
      }
      if (commandId) {
        lens.command = {
          id: commandId,
          title: count === 0 ? t("editor.vision.zeroTitle") : t("editor.vision.refs", { count: count }),
          arguments: [lens.range.startLineNumber, lens.range.startColumn],
        };
      }
      // 计数与上次不同 → 引擎索引仍在推进，调度延迟自校正
      const key = `${model.uri.toString()}:${lens.range.startLineNumber}:${lens.range.startColumn}`;
      const prev = lastCounts.get(key);
      lastCounts.set(key, count);
      if (prev !== undefined && prev !== count) scheduleStableRefresh();
      return lens;
    },
  };
  store.add(app.monaco.languages.registerCodeLensProvider("python", provider));

  // 刷新触发：内容变更 / 换文件 / 引擎首扫完成后的延迟补一炮（documentSymbol 早期为空时兜底）
  store.add(editor.onDidChangeModelContent(() => fire()));
  store.add(editor.onDidChangeModel(() => {
    closePopup(); // 换文件即收起引用弹层
    fire();
  }));
  const warmup = window.setTimeout(() => {
    for (const l of listeners) l(provider);
  }, 2500);
  store.add({ dispose: () => window.clearTimeout(warmup) });
  store.add({
    dispose: () => {
      window.clearTimeout(stableTimer);
      refreshFn = null;
    },
  });
  refreshFn = () => {
    for (const l of listeners) l(provider);
  };
  return store;
}
