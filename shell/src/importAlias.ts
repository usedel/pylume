// import 别名补全（对标 PyCharm「import pandas as pd」）：
// ① `import pand` → 变体项 `pandas as pd`（整段替换模块名）
// ② `import pandas as ` → 直接补别名 `pd`
// ③ `from pandas import DataFrame as ` → 补工作区学到的成员别名
// 知识源两层：内置流行库别名表（兜底）+ 工作区频率学习（scan_import_aliases 后台
// 扫描 `import X as Y` / `from X import A as B` 聚合计数，打开工作区触发一次）；
// 学习命中排在内置表之前。不依赖 LSP/intel；仅 import 行激活，不影响普通补全。
// sortText 走三层合并契约 0xx 段（"0z" 前缀，排在模板 0NN 之后）：import 行上
// 模板项 filterText（缩写）本就不命中，实际不会同屏竞争；仍高于 intel 1xx / 静态 2xx。

import { invoke } from "@tauri-apps/api/core";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { t } from "./i18n"; // 第十六批 i18n：补全 detail 走语言包

type Monaco = typeof MonacoApi;

/** 内置流行库别名表（静态知识兜底） */
export const BUILTIN_IMPORT_ALIASES: Readonly<Record<string, string>> = {
  pandas: "pd",
  numpy: "np",
  matplotlib: "mpl",
  "matplotlib.pyplot": "plt",
  seaborn: "sns",
  "plotly.express": "px",
  altair: "alt",
  tensorflow: "tf",
  "torch.nn": "nn",
  "torch.nn.functional": "F",
  polars: "pl",
  pyarrow: "pa",
  statsmodels: "sm",
  xgboost: "xgb",
  lightgbm: "lgb",
  networkx: "nx",
  sqlalchemy: "sa",
  "xml.etree.ElementTree": "ET",
  tkinter: "tk",
};

/** 工作区扫描聚合结果（Rust `scan_import_aliases` 返回结构镜像） */
export interface AliasHit {
  kind: "module" | "member";
  target: string; // module 型 = `X`；member 型 = `X.A`
  alias: string;
  count: number;
}

// 学习态（会话内）：learnWorkspaceAliases 写入；扫描失败/未触发时为空，纯走内置表
let learned: AliasHit[] = [];
export function setLearnedAliases(hits: readonly AliasHit[]): void {
  learned = [...hits];
}
export function learnedAliases(): readonly AliasHit[] {
  return learned;
}

/**
 * 工作区频率学习（打开工作区触发一次，失败静默）：
 * 先读上次扫描的工作区缓存（秒生效），再后台重扫（scan 落盘回写缓存，保持新鲜）。
 */
export async function refreshImportAliases(root: string): Promise<void> {
  try {
    const cached = await invoke<AliasHit[] | null>("read_import_aliases", { root });
    if (cached && cached.length > 0) setLearnedAliases(cached);
  } catch {
    /* 缓存读取失败不致命，直接走重扫 */
  }
  try {
    setLearnedAliases(await invoke<AliasHit[]>("scan_import_aliases", { root }));
  } catch (e) {
    console.warn("[importAlias] 别名学习扫描失败", e);
  }
}

export type ImportAliasContext =
  | { kind: "module"; typed: string } // `import <typed>`（模块名输入中，可为空）
  | { kind: "alias"; path: string; typed: string } // `import <path> as <typed>`
  | { kind: "fromAlias"; module: string; member: string; typed: string }; // `from M import A as <typed>`

/**
 * 从行前缀（光标之前的部分，可含先前行）解析 import 别名补全上下文。
 * 仅认 `import …` / `from … import …` 行首，其余位置返回 null（不污染普通补全）。
 * 跨行：光标行不直接匹配时，回溯前文找未闭合的 from-import 圆括号/逗号续行，
 * 以 `from M import <光标行>` 虚拟前缀重判（朴素口径：字符串/注释内形态不排除）。
 */
export function resolveImportAliasContext(linePrefix: string): ImportAliasContext | null {
  const direct = resolveSingleLineContext(linePrefix);
  if (direct || !linePrefix.includes("\n")) return direct;
  const lines = linePrefix.split("\n");
  const module = openFromModule(lines.slice(0, -1));
  if (!module) return null;
  const cur = lines[lines.length - 1].trim().replace(/\)+$/, "").trim();
  if (!cur) return null;
  return resolveSingleLineContext(`from ${module} import ${cur}`);
}

/** 单行（无换行）上下文解析 */
function resolveSingleLineContext(linePrefix: string): ImportAliasContext | null {
  const asMatch = /^\s*import\s+([\w.]+)\s+as\s+(\w*)$/.exec(linePrefix);
  if (asMatch) return { kind: "alias", path: asMatch[1], typed: asMatch[2] };
  const modMatch = /^\s*import\s+([\w.]*)$/.exec(linePrefix);
  if (modMatch) return { kind: "module", typed: modMatch[1] };
  const fromMatch = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(linePrefix);
  if (fromMatch) {
    // 取最后一个逗号段（`A, B as ` 认 B），剥掉行首 `(`（from x import (…）
    const seg = fromMatch[2]
      .split(",")
      .pop()!
      .trimStart()
      .replace(/^\(/, "")
      .trim();
    const member = /^([\w.]+)\s+as\s*(\w*)$/.exec(seg);
    if (member) {
      return { kind: "fromAlias", module: fromMatch[1], member: member[1], typed: member[2] };
    }
  }
  return null;
}

/** 回溯前文，返回最近一个未闭合的 from-import 语句的模块名（null = 无续行）。
 *  续行判定与 autoImport.importedNames 同口径：行以 ',' / '(' 结尾则继续，闭括号或
 *  其他行收束；空行/纯注释不打断（Python 允许括号内空行与注释）。 */
function openFromModule(prevLines: string[]): string | null {
  let pending: string | null = null;
  for (const raw of prevLines) {
    const line = raw.trim();
    if (pending) {
      if (!line || line.startsWith("#")) continue;
      pending = /[,(]$/.test(line) ? pending : null;
      continue;
    }
    const m = /^\s*from\s+([\w.]+)\s+import\s+(.*)$/.exec(raw);
    if (m) pending = /[,(]$/.test(m[2].trim()) ? m[1] : null;
  }
  return pending;
}

export interface ImportAliasItem {
  label: string;
  insertText: string;
  filterText: string;
  sortText: string;
  detail: string;
  documentation: string;
}

/** 学习表 → (target → alias)，module/member 同构；保持入参的 count 降序 */
function learnedMap(hits: readonly AliasHit[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of hits) {
    if (!m.has(h.target)) m.set(h.target, h.alias);
  }
  return m;
}

/** 由上下文构建建议项（纯函数，无 Monaco 依赖，可单测）。学习命中优先于内置表 */
export function importAliasItems(
  ctx: ImportAliasContext,
  aliases: Readonly<Record<string, string>> = BUILTIN_IMPORT_ALIASES,
  learnedHits: readonly AliasHit[] = learned,
): ImportAliasItem[] {
  const learnedByTarget = learnedMap(learnedHits);
  if (ctx.kind === "alias") {
    const alias = learnedByTarget.get(ctx.path) ?? aliases[ctx.path];
    if (!alias || (ctx.typed !== "" && !alias.startsWith(ctx.typed))) return [];
    return [item(alias, alias, alias, `import ${ctx.path} as ${alias}`)];
  }
  if (ctx.kind === "fromAlias") {
    const alias = learnedByTarget.get(`${ctx.module}.${ctx.member}`);
    if (!alias || (ctx.typed !== "" && !alias.startsWith(ctx.typed))) return [];
    return [item(alias, alias, alias, `from ${ctx.module} import ${ctx.member} as ${alias}`)];
  }
  // module 情形：学习命中（count 降序）在前、内置表在后，按 target 去重
  const typedLower = ctx.typed.toLowerCase();
  const out: ImportAliasItem[] = [];
  const seen = new Set<string>();
  const push = (target: string, alias: string): void => {
    if (seen.has(target) || !target.toLowerCase().startsWith(typedLower)) return;
    seen.add(target);
    const text = `${target} as ${alias}`;
    out.push(item(text, target, text, `import ${text}`));
  };
  for (const h of learnedHits) {
    if (h.kind === "module") push(h.target, h.alias);
  }
  for (const [path, alias] of Object.entries(aliases)) push(path, alias);
  // sortText 索引后缀钉死次序（Monaco 同 sortText 不保证稳定序）
  return out.map((it, i) => ({ ...it, sortText: `0z${String(i).padStart(2, "0")}` }));
}

function item(label: string, filterText: string, insertText: string, doc: string): ImportAliasItem {
  return {
    label,
    insertText,
    filterText,
    sortText: "0z",
    detail: t("ide.importAliasDetail"),
    documentation: doc,
  };
}

/** 注册点：仅 python 语言；触发靠单词字符输入（quickSuggestions 默认行为），无需 triggerCharacters */
export function registerImportAliasCompletion(monaco: Monaco): MonacoApi.IDisposable {
  return monaco.languages.registerCompletionItemProvider("python", {
    async provideCompletionItems(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position) {
      // 文档起点到光标的前缀（可含先前行）：跨行续行上下文判定需要看到未闭合的 from-import
      const linePrefix = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const ctx = resolveImportAliasContext(linePrefix);
      if (!ctx) return { suggestions: [] };
      const items = importAliasItems(ctx);
      if (items.length === 0) return { suggestions: [] };

      // 替换区间 = 行前缀末尾的 typed 段（点分模块名整体；word 只含最后一个
      // 点后片段，不能直接用 getWordUntilPosition）。typed 恒为光标前缀结尾
      // （正则均 $ 锚定），故可直接按长度回推；光标在词中间时把终点扩到词尾，
      // 避免 `pan|das` 插入后残留后半截。
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - ctx.typed.length,
        endColumn: Math.max(position.column, word.endColumn),
      };

      // 踩坑 #1（同 live-templates/completion.ts）：枚举在回调内读取 + 数值回退
      const kinds = monaco.languages.CompletionItemKind ?? {};
      const kindModule = kinds.Module ?? 8;
      const kindVariable = kinds.Variable ?? 4;
      const kind = ctx.kind === "module" ? kindModule : kindVariable;

      return {
        suggestions: items.map((it, i) => ({
          label: it.label,
          kind,
          insertText: it.insertText,
          sortText: it.sortText,
          filterText: it.filterText,
          detail: it.detail,
          documentation: { value: it.documentation },
          range,
          preselect: i === 0,
        })),
      };
    },
  });
}
