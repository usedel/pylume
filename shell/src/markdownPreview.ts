// Markdown 预览域模块（markdown preview dev plan v1.0 §5-T3）：
// marked（GFM）→ DOMPurify 消毒 → 图片相对路径改写（asset 协议）→ 写入 #md-preview →
// monaco.editor.colorize 异步代码高亮 → 点击委托（#锚点滚动 / 相对 .md 跳转 / http(s) 外链）。
// 与 main.ts 解耦：打开相对 md 链接经 setMarkdownLinkHandler 注入回调，避免循环依赖。

import { marked } from "marked";
import DOMPurify from "dompurify";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { app, type Tab } from "./state";
import { EDITOR_THEME_LIGHT } from "./theme/tokens";
import { basename, joinPath, parentDirOf } from "./util";
import { t } from "./i18n"; // 第十二批 i18n：Markdown 预览动态文案走语言包

// ---------- 可开关状态（会话内，不持久化；分栏宽度才持久化，见 layout.ts） ----------

let previewOpen = false;
let renderTimer: number | undefined;
let openMarkdownLink: ((path: string) => void) | null = null;

// ---------- 纯函数（可测试） ----------

/** 是否 Markdown 文件（.md / .markdown，大小写不敏感） */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** 链接分类（点击委托安全关键：除三类外一律 preventDefault，防 WebView 整页导航） */
export type MarkdownLinkKind = "anchor" | "external" | "relative-md" | "other";
export function classifyLink(href: string): MarkdownLinkKind {
  const h = href.trim();
  if (h.startsWith("#")) return "anchor";
  if (/^https?:\/\//i.test(h)) return "external";
  // 相对 md 链接：剥离 #fragment 与 ?query 后按扩展名判断
  const pathOnly = h.split("#")[0].split("?")[0];
  if (pathOnly && isMarkdownPath(pathOnly)) return "relative-md";
  return "other";
}

/** 相对 md 链接 → 绝对路径（以 md 所在目录为基准；剥离 fragment / query） */
export function resolveMarkdownLinkPath(href: string, baseDir: string): string {
  const cleaned = href.split("#")[0].split("?")[0].trim();
  return joinPath(baseDir, cleaned);
}

/** DOMPurify 消毒（剥除 <script> / javascript: / onerror 等；CSP 挡内联脚本，这里过滤恶意属性与协议） */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

function isDataUrl(src: string): boolean {
  return src.startsWith("data:");
}
function isNetworkUrl(src: string): boolean {
  return /^https?:\/\//i.test(src) || src.startsWith("//");
}

/**
 * 把渲染 HTML 里的相对图片路径改写成 asset URL。
 * - `data:` 原样保留（CSP `img-src data:` 已放行）；
 * - http(s) / 协议相对（//）不放开（受 CSP 限制，保持原样由 CSP 拦截）；
 * - 其余按相对路径：去掉 `./` 前缀 → 以 md 所在目录解析绝对路径 → toAssetUrl（默认 convertFileSrc）。
 * 越权路径由 Tauri asset scope（allow_asset_dir 动态授权的工作区根）拦截，前端只负责改写。
 */
export function rewriteImageSrcs(
  html: string,
  baseDir: string,
  toAssetUrl: (absPath: string) => string = convertFileSrc,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"))) {
    const raw = img.getAttribute("src") ?? "";
    if (!raw || isDataUrl(raw) || isNetworkUrl(raw)) continue;
    let rel = raw;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      /* 非法编码保持原样 */
    }
    const abs = joinPath(baseDir, rel.replace(/^\.(\\|\/)/, ""));
    img.setAttribute("src", toAssetUrl(abs));
  }
  return doc.body.innerHTML;
}

/** marked（GFM）→ 消毒 → 图片改写，产出可直接写入面板的 HTML（纯函数，图片改写可注入以便测试） */
export function renderMarkdownToHtml(
  md: string,
  baseDir = "",
  toAssetUrl: (absPath: string) => string = convertFileSrc,
): string {
  // async:false 强制同步返回；GFM 默认开启（表格 / 删除线 / 任务列表 / 代码块）
  const raw = marked.parse(md, { gfm: true, async: false }) as string;
  const clean = DOMPurify.sanitize(raw);
  return rewriteImageSrcs(clean, baseDir, toAssetUrl);
}

// ---------- 显隐判定（纯函数，测试显隐逻辑用） ----------

/** 当前是否应显示预览：开关开启 + 活动 tab 为 md */
export function shouldShowPreview(tab: Tab | null, open: boolean): boolean {
  return open && !!tab && isMarkdownPath(tab.path);
}

// ---------- DOM 操作 ----------

function mdPreviewEl(): HTMLElement | null {
  return document.getElementById("md-preview");
}
function mdSplitterEl(): HTMLElement | null {
  return document.getElementById("md-splitter");
}
function mdPreviewBtnEl(): HTMLButtonElement | null {
  return document.getElementById("btn-md-preview") as HTMLButtonElement | null;
}
function mdExportBtnEl(): HTMLButtonElement | null {
  return document.getElementById("btn-md-export") as HTMLButtonElement | null;
}
function mdPreviewHintEl(): HTMLElement | null {
  return document.getElementById("md-preview-hint");
}
/** 一次性引导标记（方案D）：首次打开 .md 且预览未开启时提示一次 */
const HINT_SEEN_KEY = "pylume.mdpreview_hint_seen";

/** 遍历 pre > code，按 language-xxx 异步高亮；未知语言 / colorize 失败回退纯文本 */
async function highlightCodeBlocks(container: HTMLElement): Promise<void> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("pre > code"));
  await Promise.all(
    blocks.map(async (code) => {
      const lang =
        Array.from(code.classList)
          .find((c) => c.startsWith("language-"))
          ?.slice("language-".length) ?? "";
      const text = code.textContent ?? "";
      try {
        // colorize 使用编辑器已设置的主题（init 时 setTheme(app.settings.theme)），无需也无法传入 theme 选项
        const html = await app.monaco.editor.colorize(text, lang || "plaintext", {});
        code.innerHTML = html;
      } catch {
        /* 未识别语言等：保持纯文本（textContent 不变） */
      }
    }),
  );
}

/** 读取活动 tab 内容渲染到面板（读 model.getValue()，未保存内容也实时反映） */
async function renderMarkdown(tab: Tab): Promise<void> {
  const el = mdPreviewEl();
  if (!el) return;
  el.innerHTML = renderMarkdownToHtml(tab.model.getValue(), parentDirOf(tab.path));
  await highlightCodeBlocks(el);
}

/** 按「开关 + 活动 tab 是否 md」刷新面板/分隔条/开关按钮/引导提示的显隐；显示时立即渲染 */
export function updatePreviewVisibility(): void {
  const tab = app.activeTab;
  const isMd = tab !== null && isMarkdownPath(tab.path);
  const show = previewOpen && isMd;
  mdPreviewEl()?.classList.toggle("hidden", !show);
  mdSplitterEl()?.classList.toggle("hidden", !show);

  // 方案A：活动 .md 即显示开关按钮（未开启/已开启都可见），已开启时高亮 + 切换 tooltip/aria
  const btn = mdPreviewBtnEl();
  if (btn) {
    btn.classList.toggle("hidden", !isMd);
    btn.classList.toggle("active", previewOpen);
    btn.setAttribute("aria-pressed", String(previewOpen));
    const chord = app.settings.keybindings.markdown_preview || "Ctrl+Shift+V";
    btn.dataset.tip = previewOpen ? t("editor.md.close") : t("editor.md.openWithKey", { key: chord });
    btn.setAttribute("aria-label", previewOpen ? t("editor.md.close") : t("editor.md.open"));
  }

  // 导出按钮：活动 .md 即显示（导出不依赖预览是否开启）
  mdExportBtnEl()?.classList.toggle("hidden", !isMd);

  // 方案D：预览未开启 + 活动 .md 时可能显示一次性引导；开启后立即隐藏
  if (previewOpen) hidePreviewHint();
  else if (isMd) maybeShowPreviewHint();
  else hidePreviewHint();

  if (show && tab) void renderMarkdown(tab);
}

// ---------- 开关 / 防抖 ----------

export function setPreviewOpen(open: boolean): void {
  previewOpen = open;
  updatePreviewVisibility();
}

export function togglePreview(): void {
  previewOpen = !previewOpen;
  updatePreviewVisibility();
}

export function isPreviewOpen(): boolean {
  return previewOpen;
}

export function setMarkdownLinkHandler(fn: (path: string) => void): void {
  openMarkdownLink = fn;
}

/** 内容变更 → 防抖渲染（约 300ms，独立定时器；渲染条件由 shouldShowPreview 收敛） */
export function schedulePreviewRender(delay = 300): void {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    const tab = app.activeTab;
    if (tab && shouldShowPreview(tab, previewOpen)) void renderMarkdown(tab);
  }, delay);
}

// ---------- 点击委托（安全关键） ----------

/**
 * 面板点击委托：#锚点 → 面板内 scrollIntoView；相对 .md → openMarkdownLink 回调；
 * http(s) → Rust open_external 打开系统浏览器；其余（mailto/data/file 等）一律 preventDefault。
 */
export function wireMarkdownClicks(): void {
  mdPreviewEl()?.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault(); // 先拦下所有导航，再按分类放行受控动作
    const href = a.getAttribute("href") ?? "";
    const kind = classifyLink(href);
    if (kind === "anchor") {
      const target = decodeURIComponent(href.slice(1));
      const node = document.getElementById(target) ?? document.querySelector(`a[name="${target}"]`);
      node?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (kind === "external") {
      void invoke("open_external", { url: href }).catch(console.error);
      return;
    }
    if (kind === "relative-md" && app.activeTab) {
      const abs = resolveMarkdownLinkPath(href, parentDirOf(app.activeTab.path));
      openMarkdownLink?.(abs);
      return;
    }
    // other：已 preventDefault，不导航
  });
}

// ---------- 方案A/D：开关按钮 + 一次性引导 ----------

/** 方案D：首次打开 .md 且预览未开启时显示一次引导（localStorage 标记，重启后不再打扰） */
function maybeShowPreviewHint(): void {
  if (localStorage.getItem(HINT_SEEN_KEY)) return;
  localStorage.setItem(HINT_SEEN_KEY, "1");
  const hint = mdPreviewHintEl();
  if (!hint) return;
  const chord = app.settings.keybindings.markdown_preview || "Ctrl+Shift+V";
  const text = hint.querySelector("#md-preview-hint-text");
  if (text) text.textContent = t("editor.md.hintWithKey", { key: chord });
  hint.classList.remove("hidden");
}

function hidePreviewHint(): void {
  mdPreviewHintEl()?.classList.add("hidden");
}

/** 方案A：绑定悬浮开关按钮点击（toggle）、导出按钮与引导关闭按钮 */
export function wireMarkdownControls(): void {
  mdPreviewBtnEl()?.addEventListener("click", () => togglePreview());
  mdExportBtnEl()?.addEventListener("click", () => void exportActiveMarkdown());
  mdPreviewHintEl()?.querySelector("#md-preview-hint-close")?.addEventListener("click", hidePreviewHint);
}

// ---------- 导出 HTML（P3：base64 内联图片 + 固定浅色主题） ----------

/** 图片扩展名 → MIME（导出 base64 data URI 用） */
function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  };
  return map[ext] ?? "image/png";
}

/** 把渲染结果里的本地图片改写成 base64 data URI（异步读文件字节） */
async function inlineImagesBase64(doc: Document, baseDir: string): Promise<void> {
  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"));
  await Promise.all(
    imgs.map(async (img) => {
      const raw = img.getAttribute("src") ?? "";
      if (!raw || raw.startsWith("data:") || /^https?:\/\//i.test(raw) || raw.startsWith("//")) return;
      let rel = raw;
      try { rel = decodeURIComponent(raw); } catch { /* 保持原样 */ }
      const abs = joinPath(baseDir, rel.replace(/^\.(\\|\/)/, ""));
      try {
        const b64 = await invoke<string>("read_file_base64", { path: abs });
        img.setAttribute("src", `data:${mimeOf(abs)};base64,${b64}`);
      } catch {
        // 图片读取失败（不存在 / 越权等）：保留原相对路径，不阻塞导出
      }
    }),
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 组装自包含 HTML：固定浅色主题 + 已高亮代码块 + 已内联图片 */
async function buildExportHtml(mdText: string, baseDir: string, title: string): Promise<string> {
  const raw = marked.parse(mdText, { gfm: true, async: false }) as string;
  const clean = DOMPurify.sanitize(raw);
  const doc = new DOMParser().parseFromString(clean, "text/html");
  await inlineImagesBase64(doc, baseDir);
  // 代码高亮：导出稿是自包含浅色文档，故临时切到浅色主题再 colorize。
  // 批 4：切的是 pylume-light（自定义浅色主题）而非出厂 "vs"——否则导出文件里的代码块
  // 配色与用户在编辑器里看到的不是同一套（方案 §5.4 连带项）。
  // ⚠ 恢复路径收在 withEditorTheme 内部：setTheme 是全局副作用，泄漏会静默污染用户会话着色。
  await app.withEditorTheme(EDITOR_THEME_LIGHT, app.settings.theme, () => highlightCodeBlocks(doc.body));
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body class="markdown-body">
${doc.body.innerHTML}
</body>
</html>`;
}

/** 导出当前活动 md 为 HTML：弹保存对话框 → 生成自包含 HTML → write_file 写入 */
export async function exportActiveMarkdown(): Promise<void> {
  const tab = app.activeTab;
  if (!tab || !isMarkdownPath(tab.path)) return;
  const title = basename(tab.path).replace(/\.(md|markdown)$/i, "");
  const html = await buildExportHtml(tab.model.getValue(), parentDirOf(tab.path), title);
  const target = await save({
    title: t("editor.md.exportTitle"),
    defaultPath: `${title}.html`,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (!target) return; // 用户取消
  await invoke("write_file", { path: target, content: html });
}

/** 导出用固定浅色主题的 Markdown 样式（自包含，浏览器打开即用；与 IDE 内深/浅自适应预览分离） */
const EXPORT_CSS = `
.markdown-body {
  color: #24292f;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  max-width: 860px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
  word-wrap: break-word;
}
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  font-weight: 600;
  line-height: 1.25;
  margin: 1.5em 0 0.75em;
}
.markdown-body h1 { font-size: 2em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
.markdown-body h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
.markdown-body h3 { font-size: 1.25em; }
.markdown-body p { margin: 0.75em 0; }
.markdown-body a { color: #0969da; text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body code {
  font-family: "Consolas", "Cascadia Code", "JetBrains Mono", monospace;
  background: rgba(175, 184, 193, 0.2);
  border-radius: 6px;
  padding: 0.2em 0.4em;
  font-size: 85%;
}
.markdown-body pre {
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 16px;
  overflow-x: auto;
  margin: 0.75em 0;
}
.markdown-body pre code { background: transparent; padding: 0; font-size: 100%; }
.markdown-body blockquote {
  margin: 0.75em 0;
  padding: 0 1em;
  color: #57606a;
  border-left: 4px solid #d0d7de;
}
.markdown-body ul, .markdown-body ol { margin: 0.75em 0; padding-left: 2em; }
.markdown-body li { margin: 0.25em 0; }
.markdown-body table { border-collapse: collapse; margin: 0.75em 0; display: block; overflow-x: auto; }
.markdown-body th, .markdown-body td { border: 1px solid #d0d7de; padding: 6px 13px; }
.markdown-body th { background: #f6f8fa; font-weight: 600; }
.markdown-body img { max-width: 100%; box-sizing: border-box; }
.markdown-body hr { border: none; border-top: 2px solid #d0d7de; margin: 1.5em 0; }
.markdown-body li.task-list-item { list-style: none; margin-left: -1.5em; }
.markdown-body input[type="checkbox"] { margin-right: 0.4em; }
.markdown-body del { color: #57606a; }
`;