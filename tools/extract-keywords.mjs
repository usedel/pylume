// tools/extract-keywords.mjs
//
// 用途：从 monaco-editor 自带的 basic-languages Monarch 定义中提取各语言的 `language.keywords`，
// 生成 shell/src/completion/keywords.gen.ts —— 零引擎「静态关键字补全」的数据源。
// 用法：node tools/extract-keywords.mjs（仓库根 / tools / shell 下均可执行）
//
// 为什么不直接 import：
//   1) monaco-editor 的 package.json 无 `"type": "module"`，Node 会把 .js 当 CJS 解析并报 `export` 语法错；
//   2) basic-languages 下只有 10 字节的 *.contribution.d.ts，没有 language.d.ts，
//      TS 侧 `import { language } from ".../python/python"` 缺类型声明。
//   构建期文本提取同时规避这两个问题，且不把 Monaco 内部路径耦合进运行时。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MONACO_DIR = join(ROOT, "shell/node_modules/monaco-editor");
const SRC_DIR = join(MONACO_DIR, "esm/vs/basic-languages");
const OUT_FILE = join(ROOT, "shell/src/completion/keywords.gen.ts");

// 与 shell/src/monaco.ts 注册的语法高亮语言一致（含 util.ts languageOf 的映射目标）。
// 不纳入 python：Python 由静态引擎（pyrefly/basedpyright）+ 运行时 intel + live templates 提供补全，
// 再加一份关键字会在补全弹窗里产生重复项。
const LANGUAGES = [
  "yaml",
  "ini",
  "markdown",
  "restructuredtext",
  "html",
  "css",
  "scss",
  "shell",
  "dockerfile",
  "bat",
  "powershell",
  "sql",
  "xml",
  "javascript",
  "typescript",
  "rust",
];

// 手工补充：json 的 Monarch 是 monaco.ts:68-92 手写的（basic-languages 无 json 目录），
// 其关键字只有这三个字面量（见 where 的 `true|false|null` 规则）。
const MANUAL_KEYWORDS = { json: ["true", "false", "null"] };

/** 读取字符串字面量，返回内容与下一个扫描位置（支持 \ 转义）。 */
function readString(source, quoteIdx) {
  const quote = source[quoteIdx];
  let out = "";
  let i = quoteIdx + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      out += source[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === quote) return { value: out, next: i + 1 };
    out += c;
    i++;
  }
  throw new Error(`未闭合的字符串字面量（偏移 ${quoteIdx}）`);
}

/**
 * 从 `[` 开始扫描数组，收集第一层的字符串字面量。
 * 跳过行/块注释——Monarch 的 keywords 数组里带注释（如 python 的 kwlist 说明）。
 */
function scanStringArray(source, openIdx, file) {
  const items = [];
  let depth = 1;
  let i = openIdx + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const { value, next } = readString(source, i);
      if (depth === 1) items.push(value);
      i = next;
      continue;
    }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") {
      depth--;
      if (depth === 0) return items;
    }
    i++;
  }
  throw new Error(`未闭合的数组字面量：${file}`);
}

/**
 * 提取单语言文件的 keywords。
 * 两种字面量形态（Monarch 自身写法不一）：
 *   - 数组：`keywords: ["if", "else"]`（多数语言）
 *   - 正则：`keywords: /if|else|for/`（如 bat）
 * 其余形态（引用外部变量、无关键字概念）返回 null，由调用方报警并跳过。
 */
function extractKeywords(file) {
  const source = readFileSync(file, "utf8");
  const arrMatch = /(?:^|\n)[ \t]*keywords[ \t]*:[ \t]*\[/.exec(source);
  if (arrMatch) {
    const openIdx = arrMatch.index + arrMatch[0].length - 1; // m[0] 末尾即 `[`
    return normalize(scanStringArray(source, openIdx, file));
  }
  const reMatch = /(?:^|\n)[ \t]*keywords[ \t]*:[ \t]*\/(.+?)\/[a-z]*[ \t]*,/.exec(source);
  if (reMatch) return normalize(reMatch[1].split("|"));
  return null;
}

/** 归一化：去空白、丢空项、只留可作标识符补全的词（排除纯符号 / 含空白的非常规项）。 */
function normalize(raw) {
  return raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s));
}

function dedupeSorted(items) {
  return [...new Set(items)].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : 1));
}

const monacoVersion = JSON.parse(readFileSync(join(MONACO_DIR, "package.json"), "utf8")).version;

if (!existsSync(SRC_DIR)) {
  console.error(`[extract-keywords] 未找到 ${SRC_DIR}，请先在 shell/ 下执行 npm install`);
  process.exit(1);
}

const result = {};
const skipped = [];
for (const lang of LANGUAGES) {
  const file = join(SRC_DIR, lang, `${lang}.js`);
  if (!existsSync(file)) {
    skipped.push(`${lang}（缺少 ${lang}.js）`);
    continue;
  }
  const items = extractKeywords(file);
  if (!items || items.length === 0) {
    skipped.push(`${lang}（Monarch 定义无内联 keywords 数组）`);
    continue;
  }
  result[lang] = dedupeSorted(items);
}
for (const [lang, items] of Object.entries(MANUAL_KEYWORDS)) {
  result[lang] = dedupeSorted([...(result[lang] ?? []), ...items]);
}

const langs = Object.keys(result).sort();
if (langs.length === 0) {
  console.error("[extract-keywords] 未提取到任何关键字，格式可能已随 Monaco 升级变化");
  process.exit(1);
}

/** 按 ~100 列折行，避免生成文件出现超长行。 */
function formatArray(items, indent) {
  const lines = [];
  let line = "";
  const pad = " ".repeat(indent);
  for (const it of items) {
    const piece = `${line ? " " : ""}"${it}",`;
    if (line && (pad + line + piece).length > 100) {
      lines.push(pad + line);
      line = `"${it}",`;
    } else {
      line += piece;
    }
  }
  if (line) lines.push(pad + line);
  return lines.join("\n");
}

const body = langs
  .map((lang) => `  ${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(lang) ? lang : JSON.stringify(lang)}: [\n${formatArray(result[lang], 4)}\n  ],`)
  .join("\n");

const header = `// 本文件由 tools/extract-keywords.mjs 生成，请勿手动编辑。
// 数据源：monaco-editor@${monacoVersion} 的 basic-languages Monarch \`language.keywords\`
//         （json 为手工补充，见脚本内 MANUAL_KEYWORDS）。
// 重新生成：node tools/extract-keywords.mjs
// 用途：零引擎静态关键字补全（shell/src/completion/keywordCompletion.ts）。
// 不含 python：Python 补全由静态引擎 / 运行时 intel / live templates 三段提供。
`;

const content = `${header}
/** 语言 ID → 静态关键字表（已去重、按字典序排列） */
export const KEYWORDS: Record<string, readonly string[]> = {
${body}
};

/** 支持关键字补全的语言 ID（= KEYWORDS 的键，provider 直接用它注册） */
export const KEYWORD_LANGUAGES: readonly string[] = Object.keys(KEYWORDS);
`;

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, content, "utf8");

const total = langs.reduce((n, l) => n + result[l].length, 0);
console.log(`[extract-keywords] 已生成 ${OUT_FILE}`);
console.log(`[extract-keywords] ${langs.length} 种语言 / ${total} 条关键字：`);
for (const lang of langs) console.log(`  ${lang.padEnd(18)} ${result[lang].length}`);
if (skipped.length > 0) console.log(`[extract-keywords] 跳过：${skipped.join("; ")}`);
