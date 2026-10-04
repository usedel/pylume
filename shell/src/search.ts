// 全局搜索面板：工作区递归文本搜索（Tauri search_workspace 命令）。
// UI：侧栏第三个 tab（SEARCH），输入框 + 大小写开关 + 结果树（文件分组，行级匹配）。
// 点击匹配 → 打开文件并定位行列。

import { invoke } from "@tauri-apps/api/core";
import { emptyState, errMsg, relativePath } from "./util";
import { t } from "./i18n"; // 第十批 i18n：搜索域动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { buildLineMatcher, compileFileMask, type LineMatcher } from "./searchFilters";

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  column: number;
  length: number;
}

interface SearchResult {
  matches: SearchMatch[];
  files_scanned: number;
  files_skipped: number;
  files_skipped_binary: number;
  truncated: boolean;
}

/** 匹配点击回调（main.ts 注入：openFile + 定位） */
let onOpenMatch: ((m: SearchMatch) => void) | null = null;
export function setOpenMatchHandler(fn: (m: SearchMatch) => void): void {
  onOpenMatch = fn;
}

// ---------- E-5（PyCharm 调研）：搜索 scope（当前文件 / 打开的标签 / 整个工作区） ----------

export type SearchScopeMode = "workspace" | "tabs" | "file";

/** scope 参数：tabs / file 模式由调用方给出文件路径列表；workspace 走 Rust 全仓搜索 */
export interface SearchScope {
  mode: SearchScopeMode;
  paths: string[];
}

/** scope 内搜索的匹配上限（对齐后端 MAX_MATCHES，G-1 有界） */
const SCOPE_MAX_MATCHES = 5000;

/** PR-H（dx_features_backlog §6.6）：搜索附加开关——正则模式 + 文件掩码 */
export interface SearchOptions {
  /** 正则模式（默认子串） */
  useRegex?: boolean;
  /** 文件掩码：`*.py` 任意深度、`pkg/*.py` 按工作区相对路径锚定（语义与 Rust 侧一致） */
  fileGlob?: string;
}

/** 在指定文件列表内匹配（读文件走 read_file，与引用面板行文本同源）。
 *  返回 null = 令牌过期（在途结果应丢弃）。text 存整行原文（列号即原行列，跳转/高亮都精确）。
 *  PR-H：匹配统一由 LineMatcher 承担（子串/正则同源），掩码在此过滤候选路径。 */
async function searchInFiles(
  matcher: LineMatcher,
  root: string,
  paths: string[],
  token: number,
  maskTest?: (relPath: string) => boolean,
): Promise<SearchResult | null> {
  const matches: SearchMatch[] = [];
  let scanned = 0;
  let truncated = false;
  for (const path of paths) {
    if (maskTest && !maskTest(relativePath(root, path))) continue;
    let content: string;
    try {
      content = await invoke<string>("read_file", { path });
    } catch {
      continue; // 文件已被删除/不可读：跳过，不算失败
    }
    if (token !== searchToken) return null; // 过期请求，丢弃
    scanned++;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const hit of matcher(line)) {
        if (matches.length >= SCOPE_MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({ path, line: i + 1, text: line, column: hit.column, length: hit.length });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { matches, files_scanned: scanned, files_skipped: 0, files_skipped_binary: 0, truncated };
}

/** 高亮匹配片段：匹配前 40 字符 + 匹配段 + 后文（截断长行） */
function renderMatchLine(container: HTMLElement, m: SearchMatch): void {
  const text = m.text;
  const start = m.column - 1;
  // 列号基于原行，但 text 已 trim——换算 trim 掉的前缀长度
  const lead = text.length - text.trimStart().length;
  const rel = start - lead;
  const before = rel > 0 ? text.slice(0, Math.min(rel, 60)) : "";
  const hitStart = Math.max(0, rel);
  const hitEnd = Math.min(text.length, hitStart + m.length);
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

/** 单批渲染的匹配上限：超过则分批 +「加载更多」，避免一次性构建数千 DOM 节点卡顿 */
const RENDER_BATCH = 500;

/** 构建单条匹配行（行号 + 高亮文本，点击跳转） */
function buildMatchLine(m: SearchMatch): HTMLElement {
  const lineEl = document.createElement("div");
  lineEl.className = "search-match";
  const lineNo = document.createElement("span");
  lineNo.className = "search-line-no";
  lineNo.textContent = String(m.line);
  const textEl = document.createElement("span");
  textEl.className = "search-match-text";
  renderMatchLine(textEl, m);
  lineEl.append(lineNo, textEl);
  lineEl.addEventListener("click", () => onOpenMatch?.(m));
  return lineEl;
}

/** 构建文件分组头（文件名 + 该文件匹配总数；E-5：可点击折叠/展开该文件组） */
function buildFileHeader(path: string, total: number): HTMLElement {
  const fileEl = document.createElement("div");
  fileEl.className = "search-file";
  const name = document.createElement("div");
  name.className = "search-file-name";
  name.textContent = `${path.split(/[\\/]/).pop()} (${total})`;
  name.title = path;
  // E-5：折叠切换。可点击 div 补 disclosure 语义（UI-16：role=button + 键盘激活 + aria-expanded）
  name.setAttribute("role", "button");
  name.tabIndex = 0;
  name.setAttribute("aria-expanded", "true");
  const toggle = (): void => {
    const collapsed = fileEl.classList.toggle("collapsed");
    name.setAttribute("aria-expanded", String(!collapsed));
  };
  name.addEventListener("click", toggle);
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  fileEl.appendChild(name);
  return fileEl;
}

/** 搜索请求令牌：每次搜索自增；结果返回时校验，过期（被更新的搜索取代）即丢弃 */
let searchToken = 0;

/** 作废进行中的搜索（令牌自增，在途结果返回时校验失败即丢弃）；视图隐藏时调用 */
export function cancelSearch(): void {
  searchToken++;
}

/** 清空搜索结果并作废在途搜索（工作区切换时调用，避免旧工作区结果残留） */
export function resetSearch(): void {
  cancelSearch();
  const results = document.getElementById("search-results");
  if (results) results.textContent = "";
}

/** 执行搜索并渲染结果树（文件分组 + 分批渲染；E-5：scope 非工作区时在指定文件内搜索） */
export async function runSearch(
  root: string,
  query: string,
  caseSensitive: boolean,
  resultEl: HTMLElement,
  scope?: SearchScope,
  opts?: SearchOptions,
): Promise<void> {
  const token = ++searchToken;
  resultEl.textContent = "";
  if (!query.trim()) {
    appendHint(resultEl, t("search.hint.enter"));
    return;
  }
  // PR-H：模式串与掩码先编译——非法输入把原因直接告诉用户，
  // 不静默降级（静默会让用户以为「开关没生效」；Rust 侧同一口径）
  let matcher: LineMatcher;
  try {
    matcher = buildLineMatcher(query, caseSensitive, opts?.useRegex === true);
  } catch (e) {
    appendHint(resultEl, e instanceof Error ? e.message : String(e));
    return;
  }
  const mask = compileFileMask(opts?.fileGlob);
  if (mask?.error) {
    appendHint(resultEl, mask.error);
    return;
  }
  appendHint(resultEl, t("search.hint.searching"));
  let r: SearchResult;
  if (scope && scope.mode !== "workspace") {
    const local = await searchInFiles(matcher, root, scope.paths, token, mask?.test);
    if (!local) return; // 过期请求，丢弃
    r = local;
  } else {
    try {
      r = await invoke<SearchResult>("search_workspace", {
        root,
        query,
        caseSensitive,
        useRegex: opts?.useRegex === true,
        fileGlob: opts?.fileGlob?.trim() || undefined,
      });
    } catch (e) {
      if (token !== searchToken) return; // 过期请求，丢弃
      resultEl.textContent = "";
      appendHint(resultEl, t("search.hint.failed", { error: localizeBackendError(errMsg(e)) }));
      return;
    }
  }
  if (token !== searchToken) return; // 过期请求，丢弃（避免旧结果覆盖新结果）
  resultEl.textContent = "";
  if (r.matches.length === 0) {
    // D4：统一空状态（图标 + 标题 + 说明）
    resultEl.appendChild(emptyState("search", t("search.empty.title"), t("search.empty.scanned", { count: r.files_scanned })));
    return;
  }
  // 按文件分组（后端已按路径+行排序，分组保持有序）
  const groups = new Map<string, SearchMatch[]>();
  for (const m of r.matches) {
    const list = groups.get(m.path) ?? [];
    list.push(m);
    groups.set(m.path, list);
  }
  const totalMatches = r.matches.length;
  const skippedLarge = r.files_skipped - r.files_skipped_binary;
  const summary = document.createElement("div");
  summary.className = "search-summary";
  summary.textContent = `${totalMatches} 个匹配 · ${groups.size} 个文件（扫描 ${r.files_scanned}${
    r.files_skipped ? t("search.empty.skipped", { skipped: r.files_skipped, binary: r.files_skipped_binary, large: skippedLarge }) : ""
  }）${r.truncated ? t("search.empty.truncated") : ""}`;
  resultEl.appendChild(summary);

  // 分批渲染：按文件顺序推进游标，单批最多 RENDER_BATCH 条匹配；
  // 单文件匹配超出一批时，同一文件块跨批续写（不重复建文件头）。
  const fileEntries = Array.from(groups.entries());
  let entryIdx = 0; // 当前文件组索引
  let offsetInEntry = 0; // 当前文件组内已渲染匹配数
  let rendered = 0; // 累计已渲染匹配数
  let currentFileEl: HTMLElement | null = null; // 正在续写的文件块
  let currentPath: string | null = null;

  const loadMoreBtn = document.createElement("div");
  loadMoreBtn.className = "search-load-more";

  function renderBatch(): void {
    let budget = RENDER_BATCH;
    while (budget > 0 && entryIdx < fileEntries.length) {
      const [path, matches] = fileEntries[entryIdx];
      if (currentPath !== path) {
        currentFileEl = buildFileHeader(path, matches.length);
        resultEl.appendChild(currentFileEl);
        currentPath = path;
        offsetInEntry = 0;
      }
      const take = Math.min(matches.length - offsetInEntry, budget);
      for (let k = 0; k < take; k++) {
        currentFileEl!.appendChild(buildMatchLine(matches[offsetInEntry + k]));
      }
      offsetInEntry += take;
      budget -= take;
      rendered += take;
      if (offsetInEntry >= matches.length) {
        entryIdx++;
        offsetInEntry = 0;
        currentPath = null;
        currentFileEl = null;
      }
    }
    if (entryIdx < fileEntries.length) {
      loadMoreBtn.textContent = t("search.loadMore", { shown: rendered, total: totalMatches });
      if (!loadMoreBtn.isConnected) resultEl.appendChild(loadMoreBtn);
    } else if (loadMoreBtn.isConnected) {
      loadMoreBtn.remove();
    }
  }

  loadMoreBtn.addEventListener("click", () => renderBatch());
  renderBatch();
}

function appendHint(el: HTMLElement, text: string): void {
  const hint = document.createElement("div");
  // UI-12：原借用环境面板的 .env-empty（类名带 env 业务前缀，属命名泄漏），改用中性的 .hint-text
  hint.className = "hint-text";
  hint.textContent = text;
  el.appendChild(hint);
}
