// 补全内联 auto-import（PR-E · dx_features_backlog §6.5，对标 PyCharm 王牌）。
//
// 背景：Phase 0 探针（2026-09-26）证实 pyrefly 1.3.0 的 completion 不给未导入的
// 工作区符号（连项都没有，与 client capabilities 无关）→ 本模块全自研（结局 C）。
// 数据源 = G-1 工作区顶层符号索引（quickFix 灯泡同源思路，前 MAX_SCAN_FILES 个 .py），
// 选中项后经 additionalTextEdits 在模块头部插入 `from <module> import <name>`。
//
// 知识接入：importAlias 学习表 member 别名（`<module>.<name> as <alias>`）命中时
// 插入 as 形态、编辑点文本用别名（学习态优先，与 importAlias 两层知识源同序）。
//
// sortText 走四层合并契约的 0y 段：模板 0NN < **0y** < 别名 0z < intel 1xx < 静态 2xx。
// 未导入符号引擎侧本就零结果，0y 段没有 2xx 竞争（探针实测）。
//
// 红线对齐：G-1（索引文件数有界、整体 TTL+会话缓存，首次查询后台建索引不阻塞按键）；
// 纯函数（topLevelSymbolNames / importedNames / autoImportItems / autoImportContext）
// 全部导出供 vitest 单测；provider 注册走 registerAutoImportCompletion（main.ts 收口）。
//
// PR-G2（dx_features_backlog §6.6）：索引条目扩展 file/line，并导出 workspaceSymbolsSnapshot
// + onWorkspaceIndexReady 供 quickOpen 符号模式并入工作区级符号（同一份索引，双消费方）。

import { invoke } from "@tauri-apps/api/core";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app } from "./state";
import { modulePathOf } from "./quickFix";
import { learnedAliases, type AliasHit } from "./importAlias";

const MAX_INDEX_FILES = 200; // G-1：与 quickFix 的 MAX_SCAN_FILES 同口径
const MAX_ITEMS = 5; // 补全菜单最多候选数
const MIN_PREFIX_LEN = 2; // 前缀至少 2 字符才触发（降扫描/噪音）
const INDEX_TTL = 5 * 60_000; // 索引新鲜度（登记边界：文件变更不做增量失效，TTL 到期重建）

type SymbolKind = "def" | "class" | "var";

export interface IndexSymbol {
  module: string;
  name: string;
  kind: SymbolKind;
  /** PR-G2：符号所在文件绝对路径（quickOpen 工作区符号跳转用；import 语义仍走 module） */
  file: string;
  /** PR-G2：定义行号（1-based，quickOpen 跳转用） */
  line: number;
}

export interface AutoImportItemData {
  name: string;
  module: string;
  kind: SymbolKind;
  /** 插入模块头部的 import 语句（不含换行） */
  importText: string;
  /** 编辑点插入文本（member 别名命中时为别名，否则为符号名） */
  insertText: string;
  documentation: string;
}

// ---------- 纯函数（vitest 直测，不经 Monaco/invoke） ----------

/** 收集文件全部顶层（无缩进）符号名（def/class/赋值），供前缀索引。
 *  Python 硬关键字黑名单：`else:` / `try:` 等块首行会被 var 正则误收（review 建议 1）；async def 显式支持。 */
const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield",
]);

export function topLevelSymbolNames(content: string): { name: string; kind: SymbolKind; line: number }[] {
  const out: { name: string; kind: SymbolKind; line: number }[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/\s+#.*$/, "");
    if (/^\s/.test(code) || !code) continue;
    const line = i + 1; // 1-based（PR-G2：quickOpen 跳转用）
    let m = /^(?:async\s+)?def\s+(\w+)/.exec(code);
    if (m) {
      out.push({ name: m[1], kind: "def", line });
      continue;
    }
    m = /^class\s+(\w+)/.exec(code);
    if (m) {
      out.push({ name: m[1], kind: "class", line });
      continue;
    }
    m = /^(\w+)\s*(?::|=)/.exec(code);
    if (m && m[1] !== "__name__" && !PY_KEYWORDS.has(m[1])) out.push({ name: m[1], kind: "var", line });
  }
  return out;
}

/** 当前文件已通过 import 引入的名字集合（含 as 别名、import a.b 的 a 首段、圆括号跨行成员、分号多语句） */
export function importedNames(content: string): Set<string> {
  const out = new Set<string>();
  let pendingFrom = false; // from-import 圆括号跨行解析中（行以 "(" 或 "," 结尾）
  const addMember = (t: string): void => {
    const s = t.replace(/^\(+/, "").replace(/\)+$/, "").trim();
    const as = /^([\w.]+)\s+as\s+(\w+)$/.exec(s);
    if (as) out.add(as[2]);
    else if (/^\w+$/.test(s)) out.add(s);
  };
  // 单条（无分号）语句解析：import… 或 from…import…（后者可开启圆括号/逗号续行）
  const handleStmt = (stmt: string): void => {
    let m = /^import\s+(.+)$/.exec(stmt);
    if (m) {
      for (const seg of m[1].split(",")) {
        const t = seg.trim();
        if (!t) continue;
        const as = /^([\w.]+)\s+as\s+(\w+)$/.exec(t);
        // `import a.b as c` → c；`import a.b` → a（首段）；`import a` → a
        out.add(as ? as[2] : t.split(".")[0]);
      }
      return;
    }
    m = /^from\s+[\w.]+\s+import\s+(.+?)\s*$/.exec(stmt);
    if (m) {
      for (const seg of m[1].split(",")) addMember(seg);
      pendingFrom = /[,(]$/.test(stmt); // "(One," / "import (" 续行
    }
  };
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue; // 空行不打断括号续行（Python 允许括号内空行）
    if (pendingFrom) {
      // 续行：首个分号结束续行，其后是新语句
      const semi = line.indexOf(";");
      const memberPart = semi >= 0 ? line.slice(0, semi) : line;
      for (const seg of memberPart.replace(/\)+$/, ",").split(",")) {
        if (seg.trim()) addMember(seg);
      }
      pendingFrom = semi < 0 && /[,(]$/.test(line);
      if (semi >= 0) {
        for (const stmt of line.slice(semi + 1).split(";")) {
          const s = stmt.trim();
          if (s) handleStmt(s);
        }
      }
      continue;
    }
    for (const stmt of line.split(";")) {
      const s = stmt.trim();
      if (s) handleStmt(s);
    }
  }
  return out;
}

/**
 * 补全上下文：光标行前缀末尾是 ≥2 字符的标识符前缀且不在 import 行（import 行归
 * importAlias 域）→ 返回 typed；否则 null。
 */
export function autoImportContext(linePrefix: string): string | null {
  if (/^\s*(?:import|from)\s/.test(linePrefix)) return null;
  const m = /([A-Za-z_]\w*)$/.exec(linePrefix);
  if (!m || m[1].length < MIN_PREFIX_LEN) return null;
  return m[1];
}

/** 生成 auto-import 候选项（前缀过滤 + 本文件可见性排除 + 别名形态 + 排序） */
export function autoImportItems(
  typed: string,
  symbols: readonly IndexSymbol[],
  content: string,
  learned: readonly AliasHit[] = learnedAliases(),
): AutoImportItemData[] {
  const lower = typed.toLowerCase();
  const imported = importedNames(content);
  const localNames = new Set(topLevelSymbolNames(content).map((s) => s.name));
  const matched: AutoImportItemData[] = [];
  for (const s of symbols) {
    if (!s.name.toLowerCase().startsWith(lower) || s.name === typed) continue;
    if (localNames.has(s.name)) continue; // 本文件已有同名定义：import 冗余且被遮蔽
    if (imported.has(s.name)) continue; // 已导入
    const alias = learned.find((h) => h.kind === "member" && h.target === `${s.module}.${s.name}`);
    const importText = alias
      ? `from ${s.module} import ${s.name} as ${alias.alias}`
      : `from ${s.module} import ${s.name}`;
    matched.push({
      name: s.name,
      module: s.module,
      kind: s.kind,
      importText,
      insertText: alias ? alias.alias : s.name,
      documentation: importText,
    });
  }
  // 排序：大小写敏感精确前缀优先 → 名字短优先（引擎缺位，无稳定对手，需自定序）。
  // 先全量排序再截断（review 应修 3：按索引序先截断会丢掉更优候选）
  matched.sort((a, b) => {
    const ca = a.name.startsWith(typed) ? 0 : 1;
    const cb = b.name.startsWith(typed) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return a.name.length - b.name.length || a.module.localeCompare(b.module);
  });
  return matched.slice(0, MAX_ITEMS);
}

// ---------- 工作区索引（G-1：有界 + 会话缓存 + 后台构建） ----------

let index: IndexSymbol[] = [];
let indexRoot: string | null = null;
let indexReady = false; // 完成态与内容解耦（review 应修 1：空工作区否则每键重扫）
let indexAt = 0;
let indexGeneration = 0; // reset 世代号（review 阻断 1：旧工作区在途扫描不得脏写新索引）
let indexPromise: Promise<void> | null = null;

/** PR-G2：索引构建完成订阅（quickOpen 在「未就绪」时挂回调，完成后重刷候选项） */
const readySubs = new Set<() => void>();

/** PR-G2：订阅索引就绪事件；返回退订函数（组件销毁时调用，防悬挂回调） */
export function onWorkspaceIndexReady(cb: () => void): () => void {
  readySubs.add(cb);
  return () => readySubs.delete(cb);
}

/** 工作区切换时重置（main.ts openWorkspace 接线） */
export function resetAutoImportIndex(): void {
  index = [];
  indexRoot = null;
  indexReady = false;
  indexAt = 0;
  indexGeneration++;
  indexPromise = null;
}

/** PR-G2：工作区符号快照（quickOpen 符号模式消费；顺带触发 ensureIndex 后台构建）。
 *  ready=false 表示索引正在后台构建——调用方订阅 onWorkspaceIndexReady 后重取。 */
export function workspaceSymbolsSnapshot(root: string): { symbols: IndexSymbol[]; ready: boolean } {
  ensureIndex(root);
  return { symbols: index, ready: indexReady };
}

/** 首次查询后台建索引（不阻塞当前次补全——本次返回空，敲下一个字符即有数据） */
function ensureIndex(root: string): void {
  if (indexRoot === root && indexReady && Date.now() - indexAt < INDEX_TTL) return;
  if (indexPromise) return;
  indexRoot = root;
  indexReady = false;
  const gen = indexGeneration;
  indexPromise = (async () => {
    const files = await invoke<string[]>("list_workspace_files", { root });
    const pyFiles = files.filter((f) => /\.pyw?$/i.test(f)).slice(0, MAX_INDEX_FILES);
    const out: IndexSymbol[] = [];
    for (const f of pyFiles) {
      const mod = modulePathOf(f);
      if (!mod) continue;
      let content: string;
      try {
        content = await invoke<string>("read_file", { path: f });
      } catch {
        continue;
      }
      for (const { name, kind, line } of topLevelSymbolNames(content)) {
        out.push({ module: mod, name, kind, file: f, line });
      }
    }
    if (gen !== indexGeneration) return; // 途中被 reset（切换工作区）：丢弃旧结果
    index = out;
    indexReady = true;
    indexAt = Date.now();
    for (const cb of readySubs) cb(); // PR-G2：通知订阅方（quickOpen）重刷
  })()
    .catch(() => {
      if (gen === indexGeneration) indexRoot = null; // 失败允许下次重试
    })
    .finally(() => {
      if (gen === indexGeneration) indexPromise = null;
    });
}

// ---------- CompletionItem provider ----------

/** 注册 auto-import 补全 provider（main.ts init 调用，返回值入 DisposableStore） */
export function registerAutoImportCompletion(monaco: typeof MonacoApi): MonacoApi.IDisposable {
  return monaco.languages.registerCompletionItemProvider("python", {
    async provideCompletionItems(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position, _ctx, token) {
      if (token?.isCancellationRequested) return { suggestions: [] }; // quickFix.ts:229 先例
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const typed = autoImportContext(linePrefix);
      const root = app.workspaceRoot;
      if (!typed || !root) return { suggestions: [] };
      ensureIndex(root);
      if (index.length === 0) return { suggestions: [] }; // 索引未就绪（首次后台构建中）
      const items = autoImportItems(typed, index, model.getValue(), learnedAliases());
      if (items.length === 0) return { suggestions: [] };

      const insertLine = findImportInsertLineForModel(model);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - typed.length,
        endColumn: Math.max(position.column, word.endColumn),
      };
      // 踩坑 #1（同 importAlias.ts）：枚举在回调内读取 + 数值回退
      const kinds = monaco.languages.CompletionItemKind ?? {};
      const kindMap = { def: kinds.Function ?? 3, class: kinds.Class ?? 7, var: kinds.Variable ?? 6 } as const;

      return {
        suggestions: items.map((it, i) => ({
          label: it.name,
          kind: kindMap[it.kind],
          insertText: it.insertText,
          sortText: `0y${String(i).padStart(2, "0")}`,
          detail: it.importText,
          documentation: { value: it.importText },
          range,
          preselect: i === 0,
          additionalTextEdits: [
            {
              range: { startLineNumber: insertLine, startColumn: 1, endLineNumber: insertLine, endColumn: 1 },
              text: `${it.importText}\n`,
            },
          ],
        })),
      };
    },
  });
}

/** 模块头部插入行（复用 quickFix 的 findImportInsertLine 逻辑；延迟取 model 文本） */
function findImportInsertLineForModel(model: MonacoApi.editor.ITextModel): number {
  // 与 quickFix.findImportInsertLine 同口径：最后一条顶层 import 的下一行，否则模块头之后
  const lines = model.getValue().split(/\r?\n/);
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:import|from)\s/.test(lines[i])) lastImport = i;
  }
  if (lastImport >= 0) return lastImport + 2;
  return moduleHeaderEnd(lines) + 1;
}

function moduleHeaderEnd(lines: string[]): number {
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || /^(#|\/\/)/.test(lines[i].trim()))) i++;
  const first = lines[i]?.trim() ?? "";
  if (/^(?:"""|''')/.test(first)) {
    const quote = first.slice(0, 3);
    const rest = first.slice(3);
    if (rest.includes(quote)) return i + 1;
    i++;
    while (i < lines.length && !lines[i].includes(quote)) i++;
    return i + 1;
  }
  return i;
}
