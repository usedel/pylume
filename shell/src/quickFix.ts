// 自研快速修复（P4 · D-1 缺失 import 兜底 + D-2 就地创建符号）。
//
// 与 lsp/client.ts::registerLspCodeAction（引擎下发 action）互补：引擎对「未定义名字」
// 通常不给修复建议，这里按诊断文案提取名字后自研两条路：
//   · D-1 工作区里已有同名顶层符号（def/class/赋值）→「从 <module> 导入 X」；
//   · D-2 工作区也没有 →「创建函数 / 类 / 变量」按调用形态推断签名，插入文件末尾。
//
// 纯函数（extractUndefinedName / scanTopLevelSymbol / findImportInsertLine /
// buildNoqaLine 见 ruffLint / inferCallArity / buildCreateStub）全部导出供 vitest 单测；
// provider 注册走 initQuickFixActions（main.ts 的 disposable store 收口），模块顶层零副作用。
//
// 红线对齐：G-1（扫描文件数 / 缓存条目均有界）、G-6（扫描在 provider 内异步进行，
// 不阻塞主线程重活；单文件轻量逐行正则，无 worker 必要）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { app } from "./state";
import { relativePathRaw } from "./util";

/** 扫描文件数上限（G-1：工作区可能有 2 万文件，逐个读不可接受；按清单顺序取前 N 个 .py） */
const MAX_SCAN_FILES = 200;
/** 名字 → 来源缓存条目上限（G-1） */
const CACHE_MAX = 50;

const PYTHON = "python";

// ---------- 纯函数（vitest 直测，不经 Monaco/invoke） ----------

/** 从诊断文案提取未定义名字（覆盖 pyrefly / basedpyright / ruff F821 常见句式） */
export function extractUndefinedName(message: string): string | null {
  const patterns = [
    /undefined name [`'"]?([A-Za-z_]\w*)/i,
    /[`'"]([A-Za-z_]\w*)[`'"]\s+is not defined/i,
    /name [`'"]?([A-Za-z_]\w*)[`'"]?\s+is not defined/i,
    /unresolved (?:reference|import) [`'"]?([A-Za-z_]\w*)/i,
  ];
  for (const p of patterns) {
    const m = p.exec(message);
    if (m) return m[1];
  }
  return null;
}

/**
 * 引擎动作抑制清单（PR-O 探针依据：bench/reports/extract-refactor-probe-*.json，
 * 报告登记 docs/dx_features_backlog.md 第三梯队）：pyrefly 的 Extract into helper 变体
 * 产出的函数体漏 return（`def extracted_function(price, qty):` 体只有裸表达式），
 * 一键即产出坏代码——按 title 前缀过滤，直至引擎补 return 再放开。
 * 仅影响引擎下发动作；自研 D-1/D-2 动作不经此判断。
 */
export function isSuppressedEngineAction(title: string): boolean {
  return title.startsWith("Extract into helper");
}

/** 轻量解析：content 顶层（无缩进）是否有名字定义；返回定义种类 */
export function scanTopLevelSymbol(content: string, name: string): "def" | "class" | "var" | null {
  for (const line of content.split(/\r?\n/)) {
    const code = line.replace(/\s+#.*$/, "");
    if (/^\s/.test(code) || !code) continue; // 缩进行 / 空行跳过（顶层语义）
    if (new RegExp(`^def\\s+${name}\\b`).test(code)) return "def";
    if (new RegExp(`^class\\s+${name}\\b`).test(code)) return "class";
    if (new RegExp(`^${name}\\s*(?::|=)`).test(code)) return "var";
  }
  return null;
}

/** 找「模块头部」结束行（0 基，返回其后一行索引）：shebang / encoding / 前导注释 / 模块 docstring 之后 */
export function findModuleHeaderEnd(content: string): number {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || /^(#|\/\/)/.test(lines[i].trim()))) i++;
  const first = lines[i]?.trim() ?? "";
  if (/^(?:"""|''')/.test(first)) {
    const quote = first.slice(0, 3);
    const rest = first.slice(3);
    if (rest.includes(quote)) return i + 1; // 同行闭合
    i++;
    while (i < lines.length && !lines[i].includes(quote)) i++;
    return i + 1;
  }
  return i;
}

/** 找 import 插入行（1 基）：有顶层 import → 最后一条 import 的下一行；否则模块头部之后 */
export function findImportInsertLine(content: string): number {
  const lines = content.split(/\r?\n/);
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:import|from)\s/.test(lines[i])) lastImport = i;
  }
  if (lastImport >= 0) return lastImport + 2; // 该 import 行之后（1 基下一行）
  return findModuleHeaderEnd(content) + 1;
}

/** 统计 `name(` 调用的实参个数（首个匹配调用；顶层逗号计数；无法解析返回 null）。
 *  字符串字面量内的逗号/括号、注释不计；*args / **kwargs 展开传参也返回 null
 *  （签名形态未知，生成 *args, **kwargs 占位）。 */
export function inferCallArity(content: string, name: string): number | null {
  const m = new RegExp(`\\b${name}\\s*\\(`).exec(content);
  if (!m) return null;
  let depth = 0;
  let arity = 1;
  let seen = false;
  let quote: string | null = null;
  for (let i = m.index + m[0].length; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === "\\") { i++; continue; } // 转义
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#") { while (i < content.length && content[i] !== "\n") i++; continue; } // 行注释
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (c === ")" && depth === 0) return seen ? arity : 0;
      depth--;
    } else if (c === "," && depth === 0) {
      arity++;
      seen = true;
    } else if (c === "*" && depth === 0) return null; // 展开传参：形态未知
  }
  return null; // 括号未闭合（半行输入）
}

/** 生成创建 stub（插入文件末尾；kind 与 diag 处推断的使用形态对应） */
export function buildCreateStub(name: string, kind: "def" | "class" | "var", arity: number | null): string {
  if (kind === "var") return `${name} = None  # TODO: 初始化`;
  if (kind === "class") return `class ${name}:\n    """TODO: 补充类文档。"""\n`;
  const params = arity === null ? "*args, **kwargs" : Array.from({ length: arity }, (_, i) => `arg${i + 1}`).join(", ");
  return `def ${name}(${params}):\n    """TODO: 补充函数文档。"""\n    raise NotImplementedError\n`;
}

// ---------- 工作区符号查找（D-1） ----------

export interface SymbolSource {
  /** 点分模块路径（pkg/mod）；workspace 根下 __init__.py 归一为包名 */
  module: string;
  kind: "def" | "class" | "var";
}

const sourceCache = new Map<string, SymbolSource[]>();

export function resetQuickFixCache(): void {
  sourceCache.clear();
}

/** 相对工作区根的模块路径（pkg/mod.py → pkg.mod；pkg/__init__.py → pkg）。
 *  工作区内判定走 relativePathRaw（CR-28：路径归一唯一权威实现，禁止手写大小写匹配）。
 *  PR-E：导出供 autoImport.ts 复用（同一归一逻辑，禁止两处漂移）。 */
export function modulePathOf(absPath: string): string | null {
  const root = app.workspaceRoot;
  if (!root) return null;
  const rel = relativePathRaw(root, absPath);
  if (!rel) return null;
  return rel.replace(/\\/g, "/").replace(/\.(py|pyw)$/i, "").replace(/\/__init__$/i, "").replace(/\//g, ".");
}

/** 在工作区 .py 文件（前 MAX_SCAN_FILES 个，文件清单顺序）中找名字的顶层定义 */
async function findWorkspaceSymbol(name: string): Promise<SymbolSource[]> {
  const cached = sourceCache.get(name);
  if (cached) return cached;
  const root = app.workspaceRoot;
  if (!root) return [];
  let files: string[] = [];
  try {
    files = await invoke<string[]>("list_workspace_files", { root });
  } catch {
    return [];
  }
  const pyFiles = files.filter((f) => /\.pyw?$/i.test(f)).slice(0, MAX_SCAN_FILES);
  const currentModule = app.activeTab ? modulePathOf(app.activeTab.path) : null;
  const sources: SymbolSource[] = [];
  for (const f of pyFiles) {
    const mod = modulePathOf(f);
    if (!mod || mod === currentModule) continue; // 当前文件自己的定义不走 import
    let content: string;
    try {
      content = await invoke<string>("read_file", { path: f });
    } catch {
      continue;
    }
    const kind = scanTopLevelSymbol(content, name);
    if (kind) sources.push({ module: mod, kind });
    if (sources.length >= 3) break; // 有三个候选已够菜单展示
  }
  if (sourceCache.size >= CACHE_MAX) sourceCache.clear(); // 简单有界：清空重来（低频场景可接受）
  sourceCache.set(name, sources);
  return sources;
}

// ---------- Code Action provider（D-1 + D-2） ----------

function importAction(model: MonacoApi.editor.ITextModel, name: string, s: SymbolSource): MonacoApi.languages.CodeAction {
  const line = findImportInsertLine(model.getValue());
  return {
    title: `从 ${s.module} 导入 ${name}`,
    kind: "quickfix",
    isPreferred: false,
    edit: {
      edits: [
        {
          resource: model.uri,
          versionId: undefined,
          textEdit: { range: new app.monaco.Range(line, 1, line, 1), text: `from ${s.module} import ${name}\n` },
        },
      ],
    },
  };
}

function createAction(model: MonacoApi.editor.ITextModel, name: string, kind: "def" | "class" | "var", arity: number | null): MonacoApi.languages.CodeAction {
  const title =
    kind === "def" ? `创建函数 ${name}(${arity === null ? "…参数" : `${arity} 个参数`})`
    : kind === "class" ? `创建类 ${name}`
    : `创建变量 ${name} = None`;
  const last = model.getLineCount();
  const stub = buildCreateStub(name, kind, arity);
  // 追加到文件末尾：在最后一行行尾接上空行 + stub（文件以换行结尾时空行自然分隔）
  return {
    title,
    kind: "quickfix",
    isPreferred: false,
    edit: {
      edits: [
        {
          resource: model.uri,
          versionId: undefined,
          textEdit: { range: new app.monaco.Range(last, model.getLineMaxColumn(last), last, model.getLineMaxColumn(last)), text: `\n\n${stub}` },
        },
      ],
    },
  };
}

/** 注册自研快速修复 provider（main.ts init 中调用，disposable 入 store） */
export function initQuickFixActions(): void {
  app.monaco.languages.registerCodeActionProvider(PYTHON, {
    async provideCodeActions(model, range, _context, token) {
      if (token?.isCancellationRequested) return { actions: [], dispose: () => {} };
      const actions: MonacoApi.languages.CodeAction[] = [];
      const names = new Set<string>();
      // context.markers 不带 owner（IMarkerData），自取两桶 marker（IMarker 有 owner）再按范围求交
      const engine = app.monaco.editor.getModelMarkers({ owner: "pylume-lsp", resource: model.uri });
      const ruff = app.monaco.editor.getModelMarkers({ owner: "pylume-ruff", resource: model.uri });
      const markers = [...engine, ...ruff].filter(
        (m) => m.startLineNumber <= range.endLineNumber && m.endLineNumber >= range.startLineNumber,
      );
      for (const m of markers) {
        const line = model.getLineContent(m.startLineNumber) ?? "";
        if (/^\s*(?:import|from)\s/.test(line)) continue; // 坏掉的 import 行自研导入无意义（导入扫描覆盖不到 import 语句的修复）
        const name = extractUndefinedName(m.message);
        if (name) names.add(name);
      }
      for (const name of names) {
        // 本文件已有顶层定义：诊断多半是作用域/拼写问题，import / create 都不对症 → 不出主意
        if (scanTopLevelSymbol(model.getValue(), name)) continue;
        const sources = await findWorkspaceSymbol(name);
        if (sources.length > 0) {
          for (const s of sources) actions.push(importAction(model, name, s));
        } else {
          // D-2：工作区也没有 → 按调用形态创建（函数推断实参个数；类/变量固定形态）
          const arity = inferCallArity(model.getValue(), name);
          actions.push(createAction(model, name, "def", arity));
          actions.push(createAction(model, name, "class", null));
          actions.push(createAction(model, name, "var", null));
        }
      }
      return { actions, dispose: () => {} };
    },
  }, {
    providedCodeActionKinds: ["quickfix"],
  });
}
