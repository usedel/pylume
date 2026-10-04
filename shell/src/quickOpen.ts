// Search Everywhere / Quick Open（P1，PyCharm Double Shift 对标）：一个弹窗混搜
// **文件 / 符号 / 命令**，覆盖 PyCharm 三个独立入口：
//   · Double Shift      → 全量混搜（本模块的主入口，键位表里无法表达双击手势，故固定保留）
//   · Ctrl+Shift+N      → 只搜文件（goto_file）
//   · Ctrl+F12          → 只搜符号（goto_symbol，PR-G；PyCharm「文件结构」同位）
//   · Ctrl+G            → 跳行（goto_line，输入 `行` 或 `行:列`）
//
// 三个数据源都落在既有能力上，无新增协议依赖：
//   · 文件  ：后端 `list_workspace_files`（复用全局搜索的 ignore 走查，.gitignore 感知）；
//   · 符号  ：LSP `textDocument/documentSymbol`（大纲已经在用），只索引**已打开的标签页**
//             ——工作区级符号索引需要引擎侧 workspace/symbol，成本高且 pyrefly 支持不稳，
//             而「跳到自己正在改的文件的某个函数」才是高频场景；
//   · 命令  ：由 main.ts 通过 registerQuickOpenActions 注入（避免本模块反向依赖 main.ts）。
//
// 焦点模型同 recentFiles：**焦点始终留在输入框**，↑↓ 只移动高亮项。

import { invoke } from "@tauri-apps/api/core";
import { hideEl, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { KEYBINDING_META, bindingLabel } from "./keybindings";
import * as lsp from "./lsp/client";
import { onWorkspaceIndexReady, workspaceSymbolsSnapshot } from "./autoImport"; // PR-G2：工作区级符号
import { app } from "./state";
import { basename, codicon, emptyState, relativePath, renderFileIcon, symbolIcon } from "./util";
import { t } from "./i18n"; // 第十批 i18n：快速打开域动态文案走语言包

export type QuickOpenMode = "all" | "files" | "symbol" | "line" | "commands";

/** 一条可执行的命令（由 main.ts 注入） */
export interface QuickOpenAction {
  /** 唯一 id（与键位 id 对齐时可直接复用键位提示） */
  id: string;
  label: string;
  /** 键位提示（不传则尝试从键位表按 id 取） */
  hint?: string;
  run: () => void;
}

export interface QuickOpenHandlers {
  /** 打开文件（可带行号） */
  openFile: (path: string, line?: number) => void;
  /** 跳到当前文件的行 / 列 */
  gotoLine: (line: number, column: number) => void;
}

let handlers: QuickOpenHandlers | null = null;
let actions: QuickOpenAction[] = [];

export function setQuickOpenHandlers(h: QuickOpenHandlers): void {
  handlers = h;
}

export function registerQuickOpenActions(list: QuickOpenAction[]): void {
  actions = list;
}

/** 按命令面板 id 查注册条目（onboarding 巡礼「试一下」/ 数据卫生测试共用；未注册返回 null）。
 *  每次实时 find 而非缓存引用——registerQuickOpenActions 是整体替换语义，main.ts 在插件扫描后
 *  会重建注册表，缓存旧数组会拿到过期条目。 */
export function findQuickOpenAction(id: string): QuickOpenAction | null {
  return actions.find((a) => a.id === id) ?? null;
}

// ---------- 模糊匹配（纯函数，可单测） ----------

/**
 * 子序列模糊匹配打分：query 的每个字符按序在 text 中出现即可命中，返回分数（越大越优）；
 * 任一字符找不到返回 null。
 *
 * 加成分档（与 PyCharm/VS Code 的手感对齐，不追求精确）：
 *   · 连续匹配 +8 —— "omod" 打到 http_client.py 里的连续片段应显著优于散落命中；
 *   · 词首/边界（首字符，或前一位为 / \ . _ - 空格）+5 —— 路径分段与 snake_case 分段；
 *   · camelCase 大写字母 +2 —— "gc" 打到 getData；
 *   · 越靠前 +0~4 —— 同分时短前缀优先。
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;
  if (!text) return null;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const qc of q) {
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === qc) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    if (found === prev + 1) score += 8;
    else score += 1;
    if (found === 0) {
      score += 5;
    } else {
      const p = t[found - 1];
      if (p === "/" || p === "\\" || p === "." || p === "_" || p === "-" || p === " ") score += 5;
      else if (text[found] !== text[found].toLowerCase()) score += 2;
    }
    score += Math.max(0, 4 - found);
    prev = found;
    ti = found + 1;
  }
  return score;
}

/** 文件名权重：basename 命中比全路径命中更贴近意图（同分时文件名优先） */
function scoreFile(path: string, query: string): number | null {
  const name = basename(path);
  const byName = fuzzyScore(name, query);
  const byPath = fuzzyScore(relativePath(app.workspaceRoot ?? "", path), query);
  if (byName === null && byPath === null) return null;
  return Math.max(byName === null ? -1 : byName + 20, byPath === null ? -1 : byPath);
}

// ---------- 数据源缓存 ----------

/** 工作区文件清单（按路径排序）；`filesRoot` 记录所属工作区，切换即失效 */
let files: string[] = [];
let filesRoot: string | null = null;

/** 符号索引：已打开标签页的 documentSymbol（扁平化，带容器名） */
interface SymbolItem {
  path: string;
  name: string;
  container: string;
  kind: number;
  line: number;
}
let symbolIndex: SymbolItem[] = [];
/** 索引所属的文件列表指纹（标签页集合变化即重建） */
let symbolFingerprint = "";

/** 工作区切换 / 文件树增删后调用：丢弃文件清单缓存，下次打开重新拉取 */
export function invalidateQuickOpenFiles(): void {
  files = [];
  filesRoot = null;
}

async function ensureFiles(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) {
    files = [];
    filesRoot = null;
    return;
  }
  if (filesRoot === root && files.length > 0) return;
  try {
    files = await invoke<string[]>("list_workspace_files", { root });
    filesRoot = root;
  } catch (e) {
    console.warn("[quickOpen] 读取工作区文件清单失败", e);
    files = [];
    filesRoot = null;
  }
}

/** 扁平化 documentSymbol 树（保留父级链作容器名，与大纲同一口径） */
function flatten(path: string, symbols: lsp.LspDocumentSymbol[], chain: string[]): SymbolItem[] {
  const out: SymbolItem[] = [];
  for (const s of symbols) {
    const line = (s.selectionRange?.start?.line ?? s.range?.start?.line ?? 0) + 1;
    out.push({ path, name: s.name, container: chain.join(" › "), kind: s.kind, line });
    if (s.children?.length) out.push(...flatten(path, s.children, [...chain, s.name]));
  }
  return out;
}

/** 符号索引重建 in-flight 去重（P2-8）：symbol 模式下连续打字（每次 input →
 *  refresh → ensureSymbols）会让两个并发重建交错 push 同一数组 → 重复条目 /
 *  aria-activedescendant 索引错乱。后到者 await 同一 Promise，不重复执行。 */
let ensureSymbolsInflight: Promise<void> | null = null;

async function ensureSymbols(): Promise<void> {
  if (ensureSymbolsInflight) return ensureSymbolsInflight;
  ensureSymbolsInflight = ensureSymbolsInner().finally(() => {
    ensureSymbolsInflight = null;
  });
  return ensureSymbolsInflight;
}

async function ensureSymbolsInner(): Promise<void> {
  if (!app.workspaceRoot) {
    symbolIndex = [];
    symbolFingerprint = "";
    return;
  }
  const fingerprint = app.tabs.map((t) => t.path).join("|");
  if (fingerprint === symbolFingerprint && (fingerprint === "" || symbolIndex.length > 0)) return;
  symbolFingerprint = fingerprint;
  symbolIndex = [];
  // 逐条 await（与其它域同一纪律：多文件异步转发禁止 fire-and-forget）
  for (const t of app.tabs) {
    const symbols = await lsp.documentSymbols(t.path);
    symbolIndex.push(...flatten(t.path, symbols, []));
  }
}

// ---------- 候选项 ----------

interface Item {
  kind: "file" | "symbol" | "action" | "line";
  title: string;
  sub: string;
  score: number;
  /** 键位提示（命令项用） */
  hint?: string;
  /** 图标：符号/命令用 codicon 名；文件用 basename 走文件图标 */
  icon?: string;
  filePath?: string;
  run: () => void;
}

/** 上限：混搜结果过多时只保留最靠前的一批（排序后截断） */
const MAX_ITEMS = 60;

/** 解析 `file.py:12` / `:12` 形式的行号后缀（PyCharm 同款） */
export function parseLineSuffix(query: string): { query: string; line: number | null } {
  const m = /:(\d+)$/.exec(query.trim());
  if (!m) return { query: query.trim(), line: null };
  return { query: query.trim().slice(0, m.index).trim(), line: Number(m[1]) };
}

/** 命令项的键位提示：显式 hint > 键位表里同 id 的当前键位 > 空 */
function actionHint(a: QuickOpenAction): string {
  if (a.hint !== undefined) return a.hint;
  const meta = KEYBINDING_META.find((m) => m.id === a.id);
  return meta ? bindingLabel(meta.id) : "";
}

/** PR-G2：G-1 索引的符号类型（"def"|"class"|"var"）→ LSP SymbolKind（复用 symbolIcon 图标管线）。
 *  数值定义同 LSP 规范：12=Function / 5=Class / 13=Variable。纯函数（可单测）。 */
export function wsKindToLsp(kind: "def" | "class" | "var"): number {
  return kind === "def" ? 12 : kind === "class" ? 5 : 13;
}

function buildItems(mode: QuickOpenMode, query: string): Item[] {
  const out: Item[] = [];
  if (mode === "line") return out; // 行号模式不参与列表检索

  // 命令直达模式（Ctrl+Shift+P）：只列命令，不做行号后缀解析（对齐 VS Code）
  if (mode === "commands") {
    for (const a of actions) {
      const score = fuzzyScore(a.label, query.trim());
      if (score === null) continue;
      out.push({
        kind: "action",
        title: a.label,
        sub: t("search.qo.commandSub"),
        score: score + 10,
        icon: "chevron-right",
        hint: actionHint(a),
        run: a.run,
      });
    }
    return out;
  }

  // `:行号` 后缀在混搜与文件模式都支持（PyCharm 的 Ctrl+Shift+N 同款）。
  // 上文已对 line 模式提前返回，此处 mode 只可能是 all / files / symbol。
  const { query: q, line } = parseLineSuffix(query);

  if (mode === "all" || mode === "files") {
    for (const p of files) {
      const score = scoreFile(p, q);
      if (score === null) continue;
      out.push({
        kind: "file",
        title: basename(p),
        sub: app.workspaceRoot ? relativePath(app.workspaceRoot, p) : p,
        score,
        filePath: p,
        run: () => handlers?.openFile(p, line ?? undefined),
      });
    }
  }

  // PR-G（dx_features_backlog §6.6）：symbol 模式（Ctrl+F12）——符号独立入口。
  // 数据源同混搜（已打开标签的 documentSymbol）；PyCharm Ctrl+F12 语义是「本文件符号」，
  // 这里保留跨 tab 能力但给当前文件的符号 +15 加权置顶（15 > 模糊分单字符上限量级，
  // 足以压过其他 tab 的散落命中，又不至于淹没连续匹配的强候选）。
  if (mode === "all" || mode === "symbol") {
    const activePath = app.activeTab?.path;
    for (const s of symbolIndex) {
      let score = fuzzyScore(s.name, q);
      if (score === null) continue;
      if (s.path === activePath) score += 15;
      out.push({
        kind: "symbol",
        title: s.name,
        sub: `${basename(s.path)}:${s.line}${s.container ? `  ${s.container}` : ""}`,
        score,
        icon: symbolIcon(s.kind),
        filePath: s.path,
        run: () => handlers?.openFile(s.path, s.line),
      });
    }
    // PR-G2（dx_features_backlog §6.6）：工作区级符号（G-1 索引，PR-E 落地的同一份数据源）。
    // 已打开标签的文件由上方 documentSymbol 覆盖（含方法/嵌套层级，质量更高），此处跳过；
    // G-1 只有顶层符号且无容器名，给 -3 小罚分让它稳定排在同分 tab 符号之后
    //（罚分量 < 连续匹配 +8 的档位差，不会淹没强候选）。
    const root = app.workspaceRoot;
    if (root) {
      const openPaths = new Set(app.tabs.map((t) => t.path));
      for (const s of workspaceSymbolsSnapshot(root).symbols) {
        if (openPaths.has(s.file)) continue;
        const score = fuzzyScore(s.name, q);
        if (score === null) continue;
        out.push({
          kind: "symbol",
          title: s.name,
          sub: `${basename(s.file)}:${s.line}`,
          score: score - 3,
          icon: symbolIcon(wsKindToLsp(s.kind)),
          filePath: s.file,
          run: () => handlers?.openFile(s.file, s.line),
        });
      }
    }
  }

  if (mode === "all") {
    for (const a of actions) {
      const score = fuzzyScore(a.label, q);
      if (score === null) continue;
      out.push({
        kind: "action",
        title: a.label,
        sub: t("search.qo.commandSub"),
        // 命令名通常整体匹配，给一点基础权重避免被文件路径淹没
        score: score + 10,
        icon: "chevron-right",
        hint: actionHint(a),
        run: a.run,
      });
    }
  }

  out.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  return out.slice(0, MAX_ITEMS);
}

// ---------- DOM 与状态 ----------

let modalEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;

let mode: QuickOpenMode = "all";
let items: Item[] = [];
let sel = 0;
/** 异步刷新令牌（照搬 search.ts 范本：慢响应不得覆盖新结果） */
let loadToken = 0;

// ---------- B 批：最近查询历史（有界 20 条，localStorage） ----------

const HISTORY_KEY = "pylume.quickopen_history";
const HISTORY_MAX = 20;
/** -1 = 未处于历史浏览态；≥0 指向 queryHistory 下标（↑/↓ 在输入为空时回溯） */
let histIdx = -1;

function loadQueryHistory(): string[] {
  // 顶层调用（模块状态初始化），try/catch 兜底纯 Node 测试环境无 localStorage 的情况
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

let queryHistory: string[] = loadQueryHistory();

/** 记录一次生效的查询（去重置顶，有界截断）；line 模式的「123:45」不入史 */
function rememberQuery(q: string): void {
  queryHistory = [q, ...queryHistory.filter((s) => s !== q)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(queryHistory));
  } catch {
    // 存储不可用：本次会话内存仍生效
  }
}

const PLACEHOLDERS: Record<QuickOpenMode, string> = {
  all: t("search.qo.phAll"),
  files: t("search.qo.phFiles"),
  symbol: t("search.qo.phSymbol"),
  line: t("search.qo.phLine"),
  commands: t("search.qo.phCommands"),
};

/** 初始化弹窗 DOM（init 时调用一次；容器 #quick-open-modal 已在 index.html 声明） */
export function initQuickOpen(): void {
  const host = document.getElementById("quick-open-modal");
  if (!host) return;
  host.textContent = "";

  const card = document.createElement("div");
  card.className = "modal-card quick-open-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Search Everywhere");

  const input = document.createElement("input");
  input.id = "quick-open-input";
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-controls", "quick-open-list");

  const list = document.createElement("div");
  list.id = "quick-open-list";
  list.className = "quick-open-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("search.qo.listAria"));

  card.append(input, list);
  host.appendChild(card);

  modalEl = host;
  inputEl = input;
  listEl = list;

  input.addEventListener("input", () => {
    sel = 0;
    histIdx = -1; // 手动输入退出历史浏览态
    void refresh();
  });
  input.addEventListener("keydown", (e) => {
    // 与全局 window 级快捷键隔离：输入框内的按键不被任何键位截走
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // B 批：输入为空时 ↑/↓ 回溯最近查询历史
      const q = inputEl?.value.trim() ?? "";
      if (!q && mode !== "line" && queryHistory.length > 0) {
        histIdx = Math.min(histIdx + (e.key === "ArrowUp" ? 1 : -1), queryHistory.length - 1);
        if (inputEl) inputEl.value = histIdx >= 0 ? queryHistory[histIdx] : "";
        sel = 0;
        void refresh();
        return;
      }
      const n = items.length;
      if (n === 0) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      renderList();
    } else if (e.key === "Home") {
      e.preventDefault();
      sel = 0;
      renderList();
    } else if (e.key === "End") {
      e.preventDefault();
      sel = Math.max(0, items.length - 1);
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void activate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeQuickOpen();
    }
  });
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".quick-open-item");
    const idx = row ? Number(row.dataset.index) : NaN;
    if (!Number.isNaN(idx)) {
      sel = idx;
      void activate();
    }
  });
  host.addEventListener("mousedown", (e) => {
    if (e.target === host) closeQuickOpen();
  });
}

/** 打开弹窗（mode 默认混搜；seed 为预填关键词，如当前选中的词） */
export async function openQuickOpen(next: QuickOpenMode = "all", seed = ""): Promise<void> {
  if (!modalEl || !inputEl) return;
  mode = next;
  sel = 0;
  histIdx = -1; // B 批：新开弹窗重置历史浏览态
  inputEl.placeholder = PLACEHOLDERS[next];
  inputEl.value = seed;
  showEl(modalEl);
  releaseFocus?.();
  releaseFocus = trapFocus(modalEl);
  await refresh();
  inputEl.focus();
  if (seed) inputEl.select();
}

export function closeQuickOpen(): void {
  if (!modalEl) return;
  releaseFocus?.();
  releaseFocus = null;
  hideEl(modalEl);
  // 焦点归还编辑器（debugConsole Esc 同款范式）：模态走两阶段出场（100ms 动画），
  // 动画期内 input 仍可聚焦且其 keydown 带 stopPropagation —— 不还焦时 window 级
  // 快捷键（Ctrl+Shift+F 等）在此窗口被吞；动画结束后浏览器虽会把 display:none 的
  // input 焦点回落到 body，但编辑器级键位（Ctrl+B 等）仍要等用户点回编辑器才恢复。
  const ae = document.activeElement;
  if (ae && modalEl.contains(ae) && ae instanceof HTMLElement) {
    ae.blur();
    // app.editor 是「init 后非空」的 getter 约定（未初始化时抛错）；Quick Open 实际
    // 只能在 init 后打开，但 ESC 收口还焦路径保持防御（如极端时序下的单测环境）。
    try {
      app.editor.focus();
    } catch {
      /* 编辑器未初始化：焦点留在 body，window 级快捷键不受影响 */
    }
  }
}

export function isQuickOpenOpen(): boolean {
  return !!modalEl && !modalEl.classList.contains("hidden");
}

/** 重新计算候选项（数据源就绪后渲染） */
async function refresh(): Promise<void> {
  const token = ++loadToken;
  if (mode === "commands") {
    // 命令直达：不加载文件/符号索引（Ctrl+Shift+P 秒开）
    items = buildItems(mode, inputEl?.value ?? "");
  } else if (mode === "symbol") {
    // 符号直达（PR-G）：只需要 documentSymbol，跳过文件清单拉取
    await ensureSymbols();
    if (token !== loadToken) return;
    items = buildItems(mode, inputEl?.value ?? "");
    // PR-G2：工作区符号索引未就绪时后台构建，完成后重刷一次（token 守卫防旧弹窗覆盖；
    // 一次性订阅——重刷时 snapshot 已 ready，不会再挂回调）
    const root = app.workspaceRoot;
    if (root && !workspaceSymbolsSnapshot(root).ready) {
      const off = onWorkspaceIndexReady(() => {
        off();
        if (token !== loadToken || !isQuickOpenOpen()) return;
        void refresh();
      });
    }
  } else if (mode !== "line") {
    await Promise.all([ensureFiles(), ensureSymbols()]);
    if (token !== loadToken) return;
    items = buildItems(mode, inputEl?.value ?? "");
  } else {
    items = [];
  }
  if (token !== loadToken) return;
  if (sel >= items.length) sel = Math.max(0, items.length - 1);
  renderList();
}

async function activate(): Promise<void> {
  if (mode === "line") {
    const parsed = parseTargetLine(inputEl?.value ?? "");
    if (!parsed) return;
    closeQuickOpen();
    handlers?.gotoLine(parsed.line, parsed.column);
    return;
  }
  const q = inputEl?.value.trim() ?? "";
  if (q) rememberQuery(q); // B 批：生效的查询入最近历史
  const it = items[sel];
  if (!it) return;
  closeQuickOpen();
  it.run();
}

/** `123` / `123:45` → {line, column}；非法返回 null */
export function parseTargetLine(raw: string): { line: number; column: number } | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d+)(?:\s*[:：]\s*(\d+))?$/.exec(s);
  if (!m) return null;
  const line = Number(m[1]);
  if (!Number.isFinite(line) || line < 1) return null;
  const column = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isFinite(column) || column < 1) return null;
  return { line, column };
}

function renderList(): void {
  const list = listEl;
  const input = inputEl;
  if (!list || !input) return;
  list.textContent = "";

  if (mode === "line") {
    const parsed = parseTargetLine(input.value);
    const total = app.activeTab?.model.getLineCount() ?? 0;
    list.appendChild(
      emptyState(
        "go-to-file",
        // 行/列两段手工取词（嵌套插值不走 apply_ts 映射，避免语言包转义链失真）
        parsed
          ? t("search.qo.gotoLine", {
              line: parsed.line,
              column: parsed.column > 1 ? t("search.qo.gotoColumn", { column: parsed.column }) : "",
            })
          : t("search.qo.linePrompt"),
        parsed
          ? t("search.qo.lineWithTotal", { total: total })
          : t("search.qo.lineFormat", { total: total }),
        true,
      ),
    );
    input.removeAttribute("aria-activedescendant");
    return;
  }

  if (items.length === 0) {
    const q = input.value.trim();
    list.appendChild(
      emptyState(
        "search",
        q ? t("search.qo.noMatches") : t("search.qo.startTyping"),
        app.workspaceRoot
          ? (q ? t("search.qo.noMatchHint") : t("search.qo.mixedHint"))
          : t("search.qo.noWorkspaceHint"),
      ),
    );
    input.removeAttribute("aria-activedescendant");
    return;
  }

  items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = `quick-open-item${i === sel ? " active" : ""}`;
    row.id = `quick-open-item-${i}`;
    row.dataset.index = String(i);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === sel));

    // 图标槽：文件走文件图标（按扩展名着色），符号/命令走 codicon
    if (it.kind === "file") {
      row.appendChild(renderFileIcon(it.title));
    } else {
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.appendChild(codicon(it.icon ?? "symbol-misc"));
      row.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "quick-open-name";
    name.textContent = it.title;
    row.appendChild(name);

    const sub = document.createElement("span");
    sub.className = "quick-open-sub";
    sub.textContent = it.sub;
    sub.title = it.sub;
    row.appendChild(sub);

    if (it.hint) {
      const kbd = document.createElement("span");
      kbd.className = "quick-open-kbd";
      kbd.textContent = it.hint;
      row.appendChild(kbd);
    }

    list.appendChild(row);
  });
  input.setAttribute("aria-activedescendant", `quick-open-item-${sel}`);
  list.children[sel]?.scrollIntoView({ block: "nearest" });
}
