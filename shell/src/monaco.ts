// Monaco 按需加载：只引入 editor core + 所需功能 + Python 语言（冷启动优化）
// 替代 `import * as monaco from "monaco-editor"`（后者打包全部 ~90 种语言，主 chunk 3.3 MB）
// 也替代 `editor.all`（含全部编辑器功能，~3.2 MB）——只引入本项目用到的：

import * as editorApi from "monaco-editor/esm/vs/editor/editor.api";

// --- 编辑器功能（按需） ---
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching"; // 括号匹配
import "monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations"; // 光标操作
import "monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions"; // 灯泡 + 快速修复菜单入口（Ctrl+. / hover Quick Fix）
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu"; // 编辑器右键菜单（此前未引入 → 编辑器内右键无任何菜单，addAction 的入口全部不可达）
import "monaco-editor/esm/vs/editor/contrib/codelens/browser/codelensController"; // 引用计数 Code Vision（codeVision.ts）
import "monaco-editor/esm/vs/editor/contrib/comment/browser/comment"; // Ctrl+/ 行注释 / Ctrl+Shift+/ 块注释
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController"; // Ctrl+F 查找
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding"; // 代码折叠
import "monaco-editor/esm/vs/editor/contrib/format/browser/formatActions"; // Shift+Alt+F 格式化
import "monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands"; // Shift+F12 查找引用（命令 + 语言服务）
// 查找引用的 peek 结果视图：goToCommands 只带命令与 referenceProvider 语言服务，
// ReferencesController（peek 窗口）是独立 contribution，需显式引入才会 registerEditorContribution，
// 否则引擎算出了引用但结果窗口静默不显示（实测 Shift+F12 无任何 UI 反应）。
import "monaco-editor/esm/vs/editor/standalone/browser/referenceSearch/standaloneReferenceSearch";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution"; // hover
import "monaco-editor/esm/vs/editor/contrib/inlayHints/browser/inlayHintsContribution"; // 编辑器内联类型标注（runtime intel）
import "monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation"; // 自动缩进
import "monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection";
import "monaco-editor/esm/vs/editor/contrib/links/browser/links"; // 链接点击
// 行操作（PyCharm 的移动行/复制行/删除行/缩进调整等命令都在这里）：此前未引入 →
// editor.action.moveLinesUpAction / moveLinesDownAction 均不可达（C-2 依赖）。
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor"; // 多光标
import "monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints"; // 签名帮助 widget
// 注：内建 rename contribution（F2 单文件 rename widget）已移除——重命名统一走自研就地改名
// renameWidget.ts（prepareRename 锚定 + ghost 预览 + 跨文件 diff 确认），F2 由其 addCommand 接管。
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2"; // snippet 占位符会话（live templates 展开依赖，显式声明避免仅靠 suggest 传递引入）
// PR-B（dx_features_backlog §6.2）：粘性滚动（Monaco 0.52 内建 stickyScroll；按需裁剪必须显式引入，
// 否则 getOption 显示 enabled 但 contribution 不存在、widget 永不渲染——同 ReferencesController 教训）
import "monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollContribution";
// 智能选区（PyCharm Ctrl+W）：按语法层级逐级扩大/缩小选区，命令 id =
// editor.action.smartSelect.expand / .shrink（grow 是其别名）。此前未引入 → 命令不可达。
import "monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController"; // 补全 UI
import "monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter"; // 词高亮

// --- 语法高亮（Monarch 词法，无 worker；按 Python 项目常见文件类型按需引入） ---
// 配置与文档
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution"; // 兼容 toml/ini/cfg/conf 近似着色
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/restructuredtext/restructuredtext.contribution";
// Web / 文档
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution";
// 脚本 / 容器 / 数据
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution";
import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
// 其他语言
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";

// --- Python 语法：静态引入（不走 contribution 的运行时动态 import） ---
// python.contribution 经 registerLanguage 的 loader() 在**首次 tokenize 时**才
// import("./python.js")——该动态 chunk 落在 Vite dep 预打包目录（deps/python-XXXX.js，
// hash 由 esbuild 产出）。.vite 重新生成后 chunk 名漂移，而浏览器侧仍持旧 URL
// （deps 目录响应带 immutable 缓存头）→ 请求落空、动态 import 失败被 Monarch 静默吞掉
// → 「只有 py 没高亮、无任何报错」，删 .vite 临时恢复、重启后复发（实测报错：
// The file does not exist at ".../deps/python-A5SEOAVQ.js?v=..."）。
// Python 是本 IDE 主语言，语法定义（~20KB）静态打进主 chunk，运行时零动态加载，
// 彻底绕开 dep 优化器。语言注册元数据镜像 python.contribution 的 registerLanguage 条目。
import { conf as pythonConf, language as pythonLanguage } from "monaco-editor/esm/vs/basic-languages/python/python.js";

editorApi.languages.register({
  id: "python",
  extensions: [".py", ".rpy", ".pyw", ".cpy", ".gyp", ".gypi"],
  aliases: ["Python", "py"],
  firstLine: "^#!/.*\\bpython[0-9.-]*\\b",
});

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// 本地 worker 配置（去 CDN，spike 踩坑 #2 的正式解法）
// 只用 editor worker（Python 高亮是 Monarch 词法，无需语言 worker）
self.MonacoEnvironment = {
  getWorker(): Worker {
    return new editorWorker();
  },
};

// --- JSON 高亮：basic-languages 无 json 目录，官方 json 由 language/json 包提供且依赖 json worker。
// 为保持「零 worker、按需」原则，这里手写一个 Monarch tokenizer 注册，仅做语法着色。
editorApi.languages.register({ id: "json", extensions: [".json"], aliases: ["JSON", "json"] });
editorApi.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/\s+/, "white"],
      [/[{}\[\]]/, "delimiter.bracket"],
      [/[:,]/, "delimiter"],
      // 键：字符串后紧跟冒号（非贪婪 + 前瞻）
      [/"[^"\\]*(?:\\.[^"\\]*)*"(?=\s*:)/, "attribute.name"],
      // 值字符串
      [/"[^"\\]*(?:\\.[^"\\]*)*"/, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number"],
      [/\b(?:true|false)\b/, "keyword"],
      [/\bnull\b/, "keyword"],
      [/\/\/.*$/, "comment"],
      [/\/\*/, { token: "comment", next: "@comment" }],
    ],
    comment: [
      [/[^/*]+/, "comment"],
      [/\/\*/, { token: "comment", next: "@comment" }],
      [/\*\//, { token: "comment", next: "@pop" }],
      [/[/*]/, "comment"],
    ],
  },
});

// --- Python 语法绑定：语言已静态注册（见上方 import 处），conf + Monarch 立即绑定 ---
editorApi.languages.setLanguageConfiguration("python", pythonConf);
editorApi.languages.setMonarchTokensProvider("python", pythonLanguage);

// --- Monaco 取消噪声全局静默（PR-D 实测踩坑，dx_features_backlog §6.4）---
// wordHighlighter / stickyScroll 等贡献在 dispose 路径 Delayer.cancel() 会触发
// cancelable promise reject(CanceledError)，裸 Monaco 未像 VS Code 那样接全局
// error handler（「取消不是错误」哲学）→ 拒绝冒泡成 unhandledrejection/pageerror。
// 只按 CanceledError 的 name/message 精确过滤，其余拒绝照常上报，不掩盖真实错误。
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { name?: string; message?: string } | undefined;
  if (reason?.name === "Canceled" || reason?.message === "Canceled") e.preventDefault();
});

// --- 自定义主题 pylume-dark / pylume-light（ui_premium 批 4 · 设计报告 §5.4）---
//
// 改造前编辑器跑的是 Monaco 出厂 vs-dark / vs，与外壳 token 系统不同源——占屏 60–70% 的区域
// 颜色全部来自出厂主题，是「拼装感」的最大来源。
//
// **色值不在本文件**：映射表在 theme/tokens.ts，实际颜色在这里从 CSS 变量现读。所以：
//   ① 改 style.css 的 token 即改编辑器颜色，无需二次改动；
//   ② 深浅两套共用同一份映射，差异全在 CSS 的 [data-theme="light"] 覆盖层。
// 详见 theme/tokens.ts 头部「为什么本模块一个色值都没有」。
import {
  EDITOR_THEME_DARK,
  EDITOR_THEME_LIGHT,
  MONACO_COLOR_SLOTS,
  MONACO_TOKEN_SLOTS,
  THEME_BASES,
  resolveEditorTheme,
  shellThemeOf,
  toMonacoHexColor,
} from "./theme/tokens";

/** 读 CSS 变量当前值（trim：getPropertyValue 会带前导空白，不去会让 defineTheme 拿到非法颜色） */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 槽位取色：**读 CSS 变量 → 归一成 Monaco 能解析的 hex**；不可解析返回 null（调用方跳过该槽位）。
 *
 *  ⚠ 归一这步不是洁癖：Monaco 只认 hex，`rgba()` 会被 `parseHex` 判为非法并**静默变成纯红**
 *    （取证链见 theme/tokens.ts::toMonacoHexColor 的注释）。此处返回 null 而不是原样传下去，
 *    是为了让失败可见：调用方打警告 + 跳过 → 该槽位回落 base 主题（可接受），
 *    而不是变成一个「看起来像报错的红色」。 */
function slotColor(token: string): string | null {
  const raw = token.startsWith("#") ? token : cssVar(token);
  if (!raw) return null;
  return toMonacoHexColor(raw);
}

/** 注册两套自定义主题。**必须在目标 data-theme 已生效后调用**——色值是注册那一刻读到的快照。
 *
 *  故凡「先切 data-theme 再上编辑器」的路径（启动、设置保存、导出临时切换）都要重新注册，
 *  这就是 applyEditorTheme 内部无条件重注册的原因。 */
export function defineEditorThemes(): void {
  for (const name of [EDITOR_THEME_DARK, EDITOR_THEME_LIGHT]) {
    const colors: Record<string, string> = {};
    for (const [slot, token] of Object.entries(MONACO_COLOR_SLOTS)) {
      // 硬编码槽位（仅 lineHighlightBorder 的透明值）直接内联，其余现读 CSS 变量
      const value = slotColor(token);
      if (value) colors[slot] = value;
      else console.warn(`[theme] CSS 变量 ${token} 未定义或不是可解析色值，Monaco 槽位 ${slot} 回落 base 主题`);
    }
    const rules = Object.entries(MONACO_TOKEN_SLOTS)
      .map(([token, cssName]) => ({ token, foreground: slotColor(cssName) }))
      .filter((r) => {
        if (r.foreground === null) console.warn(`[theme] 语法色 ${r.token} 的 CSS 变量不可解析，该 token 回落默认前景色`);
        return r.foreground !== null;
      })
      .map((r) => ({ token: r.token, foreground: r.foreground as string }));
    editorApi.editor.defineTheme(name, { base: THEME_BASES[name], inherit: true, colors, rules });
  }
}

/** 应用编辑器主题：重注册（读当前 CSS 变量快照）后切换。
 *  旧出厂名（vs-dark / vs）由 resolveEditorTheme 归一，未知值兜底深色。 */
export function applyEditorTheme(theme: string): void {
  defineEditorThemes();
  editorApi.editor.setTheme(resolveEditorTheme(theme));
}

/** 临时切到某主题执行 fn，**结束（含抛错）后恢复原主题与原 data-theme**。
 *
 *  现存唯一调用方是 markdownPreview 的导出 HTML：导出稿是自包含浅色文档，若用用户当前的深色
 *  主题着色，代码块会变成深底色块嵌在白底文档里。但 setTheme 是**全局副作用**，一旦泄漏会静默
 *  污染用户会话的着色——故恢复路径必须收在 finally 里，且 data-theme 与 Monaco 主题**成对恢复**
 *  （只恢复其一会让下一次 defineEditorThemes 读到错的 CSS 变量快照）。
 *  from 由调用方传入而非内部读取：Monaco 没有公开的 getTheme()，而调用方持有 app.settings.theme。 */
export async function withEditorTheme<T>(to: string, from: string, fn: () => Promise<T>): Promise<T> {
  const prevShell = document.documentElement.dataset.theme ?? "dark";
  document.documentElement.dataset.theme = shellThemeOf(to);
  applyEditorTheme(to);
  try {
    return await fn();
  } finally {
    document.documentElement.dataset.theme = prevShell;
    applyEditorTheme(from);
  }
}

export default editorApi;
