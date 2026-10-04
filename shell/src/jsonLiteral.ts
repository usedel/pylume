// JSON 字面量注入 · 编辑器侧（库特别支持 P1 §7-3）：
// 高亮装饰与 pylume-libs 诊断已收敛进规则表 dispatcher（libInject.ts，dslLens 统一渲染），
// 本模块只保留 JSON 特有的两件事：多行三引号字面量的折叠区间 + 右键三项
// （格式化 / 压缩 / JSONPath 提取——后两项是既有 jsonfmt / jsonpath 能力的编辑器入口）。
// 写回一律 executeEdits（§2 纪律 4：禁 setValue 整文替换）。

import { app } from "./state";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
// Monaco 内部模块（版本锁 ci/versions.toml，升级走回归 CI）：缩进折叠复用与合并
import { IndentRangeProvider } from "monaco-editor/esm/vs/editor/contrib/folding/browser/indentRangeProvider";
import { ILanguageConfigurationService } from "monaco-editor/esm/vs/editor/common/languages/languageConfigurationRegistry";
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices";
import { DisposableStore } from "./util";
import { toast } from "./toast";
import { offsetToPosition } from "./libRegex";
import { jsonParseError, pythonLiteralFor, type JsonHit } from "./libJson";
import { scanInjectLiterals } from "./libInject";
import { setPendingJsonPathRequest } from "./libsBridge";
import { t } from "./i18n"; // 第十三批 i18n：动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { errMsg } from "./util";

const MAX_SCAN_CHARS = 500_000; // 与 dslLens 同一预算
const JSONPATH_TOOL_ID = "pylume.builtin.jsonpath";

// ---------- 右键三项 ----------

/** 光标所在 json.loads 字面量；不在任何字面量内 → toast 并返回 null */
function hitAtCursor(): JsonHit | null {
  const editor = app.editor;
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== "python") {
    toast(t("ide.json.needPy"), "info");
    return null;
  }
  const offset = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 });
  const hit = scanInjectLiterals(model.getValue()).find(
    (l) => l.rule === "json" && offset > l.start && offset < l.end,
  );
  if (!hit) {
    toast(t("ide.json.notInLiteral"), "info");
    return null;
  }
  return hit.data as JsonHit;
}

/** 重新编码字面量并写回（executeEdits 单一撤销粒度） */
function rewriteLiteral(hit: JsonHit, indent: number): void {
  let value: unknown;
  try {
    value = JSON.parse(hit.value);
  } catch (e) {
    toast(t("ide.json.parseFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }), "error");
    return;
  }
  const model = app.editor.getModel();
  if (!model) return;
  const text = model.getValue();
  if (text.slice(hit.start, hit.end) !== hit.source) return; // 扫描后源码已变 → 防误写
  const newSource = pythonLiteralFor(value, hit.quote, hit.triple, indent);
  const s = offsetToPosition(text, hit.start);
  const e = offsetToPosition(text, hit.end);
  app.editor.executeEdits("libs-json-rewrite", [
    { range: new app.monaco.Range(s.line + 1, s.col + 1, e.line + 1, e.col + 1), text: newSource },
  ]);
  app.editor.focus();
}

function openInJsonPathPanel(hit: JsonHit): void {
  const err = jsonParseError(hit.value);
  if (err) {
    toast(t("ide.json.parseFailed", { error: localizeBackendError(errMsg(err.message)) }), "error");
    return;
  }
  setPendingJsonPathRequest({ json: hit.value });
  void import("./devtools/index").then((m) => m.openDevTools(JSONPATH_TOOL_ID));
}

// ---------- 初始化 ----------

export function initJsonLiteral(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  const store = new DisposableStore();

  // 折叠：多行三引号 JSON 字面量注册折叠区间（单行字面量无行可折）。
  //
  // ⚠️ Monaco foldingStrategy=auto 语义（回归 #3 个 e2e 的根因，2026-09-27 排查）：
  // 只要任一 foldingRangeProvider 返回**数组（含空数组）**，语法折叠即接管，
  // IndentRangeProvider（缩进折叠）不再回退（syntaxRangeProvider.js: ranges 非 null 才 fallback）。
  // 此前无 JSON 字面量时返回 []，导致全部 Python 文件的缩进折叠失效——
  // 折叠图标不出现（E-DX-S2）+ sticky scroll 空壳隐藏（E-DX-ST1/ST2）。
  // 修复：无结果时返回 null（Monaco 约定 null = 弃权 → 回退缩进折叠）；
  // 有结果时**合并** Monaco 内建缩进区间（复用 IndentRangeProvider，StandaloneServices
  // 取 ILanguageConfigurationService），保证混合文件（def + 多行 JSON）的 def 折叠不丢。
  store.add(
    app.monaco.languages.registerFoldingRangeProvider("python", {
      provideFoldingRanges(model) {
        const text = model.getValue();
        if (text.length > MAX_SCAN_CHARS) return null;
        const jsonRanges = scanInjectLiterals(text)
          .filter((l) => l.rule === "json")
          .map((l) => l.data as JsonHit)
          .filter((h) => h.endLine > h.startLine)
          .map((h) => ({ start: h.startLine + 1, end: h.endLine + 1 }));
        if (jsonRanges.length === 0) return null;
        const indent = new IndentRangeProvider(
          model,
          StandaloneServices.get(ILanguageConfigurationService),
          { limit: 5000, update() {} },
        );
        // IndentRangeProvider.compute 不读 cancelationToken，直接传 undefined
        return indent.compute(undefined as never).then((regions) => {
          const out: { start: number; end: number }[] = [];
          for (let i = 0; i < regions.length; i++) {
            out.push({ start: regions.getStartLineNumber(i), end: regions.getEndLineNumber(i) });
          }
          return [...out, ...jsonRanges];
        });
      },
    }),
  );

  // 右键三项（导航组，正则入口 1.8 之后；格式化/压缩是就地写回，提取是面板入口）
  store.add(
    editor.addAction({
      id: "pylume.jsonFormat",
      label: t("ide.json.formatTitle"),
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.85,
      run: () => {
        const hit = hitAtCursor();
        if (hit) rewriteLiteral(hit, 2);
      },
    }),
  );
  store.add(
    editor.addAction({
      id: "pylume.jsonMinify",
      label: t("ide.json.minifyTitle"),
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.86,
      run: () => {
        const hit = hitAtCursor();
        if (hit) rewriteLiteral(hit, 0);
      },
    }),
  );
  store.add(
    editor.addAction({
      id: "pylume.jsonPathExtract",
      label: t("ide.json.openJsonpath"),
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.87,
      run: () => {
        const hit = hitAtCursor();
        if (hit) openInJsonPathPanel(hit);
      },
    }),
  );

  return store;
}
