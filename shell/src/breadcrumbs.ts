// Breadcrumbs 面包屑（P2 · PyCharm Breadcrumbs 对标）：编辑区顶部常驻
// 「文件 › 类 › 函数」层级链，点击即在层级间跳转。
//
// 数据源与大纲同源（LSP `textDocument/documentSymbol`，`lsp.documentSymbols`），
// 无新增协议依赖；渲染成一条**细条**而非面板——它的价值是「随时可见」，
// 一旦需要点开才能看就退化成第二个大纲了。
//
// 刷新时机：切 tab / 光标移动 / 文档变更，统一 250ms 防抖（走查整棵符号树不便宜，
// 而光标每敲一个键都会移动）。

import * as lsp from "./lsp/client";
import { app } from "./state";
import { basename, codicon, symbolIcon } from "./util";
import { t } from "./i18n"; // 第十二批 i18n：面包屑动态文案走语言包

export interface BreadcrumbItem {
  name: string;
  kind: number;
  line: number;
}

export interface BreadcrumbHandlers {
  /** 点击某层 → 定位到该符号所在行 */
  gotoLine: (line: number) => void;
}

let handlers: BreadcrumbHandlers | null = null;

export function setBreadcrumbHandlers(h: BreadcrumbHandlers): void {
  handlers = h;
}

let el: HTMLElement | null = null;
/** 防抖定时器（模块级：随工作区复位清理，不放 init 闭包） */
let timer: number | undefined;
/** 异步刷新令牌（照搬 search.ts：慢响应不得覆盖新结果） */
let token = 0;
/** 符号缓存：路径 → 符号树（大纲已在用同一数据，这里再存一份避免重复请求） */
const cache = new Map<string, lsp.LspDocumentSymbol[]>();
/** 已渲染的层级链（供单测之外的诊断用） */
let current: BreadcrumbItem[] = [];

/**
 * 计算光标所在位置的符号链（纯函数，可单测）：
 * 返回从最外层到最内层、range 覆盖 line 的符号序列。
 * 同名嵌套（如递归函数）不会死循环——每层只取**第一个**覆盖该行的子节点。
 */
export function symbolChainAt(symbols: lsp.LspDocumentSymbol[], line1: number): BreadcrumbItem[] {
  const out: BreadcrumbItem[] = [];
  let level = symbols;
  while (level.length > 0) {
    const hit = level.find((s) => covers(s, line1));
    if (!hit) break;
    out.push({
      name: hit.name,
      kind: hit.kind,
      line: (hit.selectionRange?.start?.line ?? hit.range?.start?.line ?? 0) + 1,
    });
    level = hit.children ?? [];
  }
  return out;
}

/** 符号是否覆盖某一行（1 基；range 缺失时退化为按 selectionRange 判定） */
function covers(s: lsp.LspDocumentSymbol, line1: number): boolean {
  const r = s.range;
  if (r) return r.start.line + 1 <= line1 && line1 <= r.end.line + 1;
  const sel = s.selectionRange;
  if (sel) return sel.start.line + 1 === line1;
  return false;
}

/** 初始化（init 调用一次；容器 #breadcrumbs 已在 index.html 声明） */
export function initBreadcrumbs(): void {
  el = document.getElementById("breadcrumbs");
}

/** 请求刷新（防抖 250ms） */
export function scheduleBreadcrumbs(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refreshBreadcrumbs(), 250);
}

/** 清空（工作区切换 / 关闭全部标签） */
export function resetBreadcrumbs(): void {
  window.clearTimeout(timer);
  token++;
  cache.clear();
  current = [];
  render();
}

/** 丢弃某文件的符号缓存（文档变更后重查） */
export function invalidateBreadcrumbs(path?: string): void {
  if (path) cache.delete(path);
  else cache.clear();
}

async function refreshBreadcrumbs(): Promise<void> {
  const my = ++token;
  const tab = app.activeTab;
  if (!tab || !el) {
    current = [];
    render();
    return;
  }
  let symbols = cache.get(tab.path);
  if (!symbols) {
    symbols = await lsp.documentSymbols(tab.path);
    if (my !== token) return;
    cache.set(tab.path, symbols);
  }
  const line = app.editor.getPosition()?.lineNumber ?? 1;
  current = symbolChainAt(symbols, line);
  if (my !== token) return;
  render();
}

function render(): void {
  const host = el;
  if (!host) return;
  host.textContent = "";
  const tab = app.activeTab;
  if (!tab) {
    host.classList.add("hidden");
    return;
  }
  host.classList.remove("hidden");

  // 第一层永远是文件本身（PyCharm 同款：即使光标不在任何符号内也有上下文）
  host.appendChild(crumb(basename(tab.path), "file-code", tab.path, 1, true));
  for (const item of current) {
    host.appendChild(separator());
    host.appendChild(crumb(item.name, symbolIcon(item.kind), tab.path, item.line, false));
  }
}

function separator(): HTMLElement {
  const s = document.createElement("span");
  s.className = "crumb-sep";
  s.setAttribute("aria-hidden", "true");
  s.appendChild(codicon("chevron-right"));
  return s;
}

function crumb(text: string, icon: string, path: string, line: number, isFile: boolean): HTMLElement {
  const b = document.createElement("button");
  b.className = `crumb${isFile ? " crumb-file" : ""}`;
  b.type = "button";
  b.title = path;
  b.dataset.line = String(line);
  b.setAttribute("aria-label", isFile ? t("editor.crumb.file", { text: text }) : t("editor.crumb.jump", { text: text, line: line }));
  const i = document.createElement("span");
  i.className = "crumb-icon";
  i.appendChild(codicon(icon));
  // 局部变量避开 t：t() 已是 i18n 取词函数（原变量名 t 与之撞名会遮蔽取词）
  const span = document.createElement("span");
  span.className = "crumb-text";
  span.textContent = text;
  b.append(i, span);
  b.addEventListener("click", () => handlers?.gotoLine(line));
  return b;
}

/** 当前层级链（诊断 / 单测用） */
export function breadcrumbChain(): BreadcrumbItem[] {
  return current;
}
