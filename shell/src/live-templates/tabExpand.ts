// Tab 直接展开触发器（方案 §9.1）
// 设计：when 子句让位弹窗/snippet 会话等原生 Tab 消费者；未命中缩写放行默认 tab；
//       命中后异步构建引擎上下文（剪贴板预取），期间位置变化则放弃（不补插 tab）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import type { TemplateRegistry } from "./registry";
import type { TemplateDef } from "./schema";
import { lexicalEnvAt, type SyntaxContext } from "./scope";
import { compileTemplate } from "./compiler";
import type { EngineContext } from "./engine";
import { insertSnippet } from "./snippet";

type Monaco = typeof MonacoApi;

/** 缩写扫描字符集（不含 `.`：点号场景留给成员访问/后缀补全） */
const ABBR_CHAR_RE = /[A-Za-z0-9_-]/;

export interface TabExpandHost {
  buildEngineContext(
    model: MonacoApi.editor.ITextModel,
    position: MonacoApi.Position,
    tpl: TemplateDef,
  ): Promise<EngineContext>;
  isComposing(): boolean;
  /** 上下文判定（M2：符号优先 + 启发式兜底，由 index.ts 注入；含位置轴） */
  resolveScopeInfo(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position): SyntaxContext;
}

export function registerTabExpand(
  monaco: Monaco,
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  registry: TemplateRegistry,
  host: TabExpandHost,
): MonacoApi.IDisposable {
  // CR-24：原 `{ dispose: () => void disposable }` 把 void 求值当 dispose——空操作，
  // 命令从未真正释放。改用 addAction：同样支持 keybindings + precondition（语义不变），
  // 且返回真 IDisposable（dispose 即解绑）。副作用：命令面板（F1）可按名触发，可接受。
  return editor.addAction({
    id: "pylume.liveTemplates.tabExpand",
    label: "Live Templates: 展开缩写",
    keybindings: [monaco.KeyCode.Tab],
    // 补全弹窗接受 / snippet 占位符跳转 / 重命名 / 快速修复 / 参数提示 / 无障碍焦点模式 全部优先
    precondition:
      "!suggestWidgetVisible && !inSnippetMode && !renameInputVisible && !quickFixWidgetVisible && !parameterHintsVisible && !editorTabMovesFocus",
    run: (ed) => {
      const match = matchAbbreviation(monaco, ed, registry, host);
      if (!match) {
        // 未命中：放行默认 Tab（缩进/选区缩进等原生行为）
        ed.trigger("keyboard", "tab", null);
        return;
      }
      void expand(monaco, ed, match, host);
    },
  });
}

interface TabMatch {
  tpl: TemplateDef;
  model: MonacoApi.editor.ITextModel;
  position: MonacoApi.Position;
  /** 缩写起点列（1-based） */
  startColumn: number;
}

/** 同步门控：组合输入/选区/成员访问/词法环境/缩写匹配，全部通过才进入异步展开。
 * CR-24：editor 参数放宽为 ICodeEditor（addAction 回调给的是 ICodeEditor，
 * 本函数只用 getModel/getPosition/getSelection 等基础 API） */
function matchAbbreviation(
  monaco: Monaco,
  editor: MonacoApi.editor.ICodeEditor,
  registry: TemplateRegistry,
  host: TabExpandHost,
): TabMatch | null {
  if (host.isComposing()) return null;
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return null;
  const sel = editor.getSelection();
  if (!sel || !sel.isEmpty()) return null; // 有选区时 Tab = 缩进，交给默认行为

  const line = model.getLineContent(pos.lineNumber);
  let i = pos.column - 2; // 光标前一个字符的 0-based 下标
  while (i >= 0 && ABBR_CHAR_RE.test(line[i])) i--;
  const abbr = line.slice(i + 1, pos.column - 1);
  if (!abbr) return null;
  if (i >= 0 && line[i] === ".") return null; // 成员访问位置不展开（后缀补全 M3 领域）

  const scopeInfo = host.resolveScopeInfo(model, pos);
  const tpl = registry.findByAbbreviation(abbr, scopeInfo);
  if (!tpl || !tpl.tabExpand) return null;

  const env = lexicalEnvAt(monaco, model, pos);
  if (env === "string" && !tpl.allowInStrings) return null;
  if (env === "comment" && !tpl.allowInComments) return null;

  return { tpl, model, position: pos, startColumn: i + 2 };
}

async function expand(
  monaco: Monaco,
  editor: MonacoApi.editor.ICodeEditor, // CR-24：同 matchAbbreviation 放宽
  match: TabMatch,
  host: TabExpandHost,
): Promise<void> {
  const { tpl, model, position, startColumn } = match;
  const ctx = await host.buildEngineContext(model, position, tpl);
  // await 期间用户可能继续输入/移动：放弃展开（也不补插 tab）
  const nowPos = editor.getPosition();
  if (editor.getModel() !== model || !nowPos || !nowPos.equals(position)) return;

  const snippet = compileTemplate(tpl, ctx);
  // 选中缩写 → snippet 插入替换之并进入占位符会话
  editor.setSelection(new monaco.Selection(position.lineNumber, startColumn, position.lineNumber, position.column));
  if (!insertSnippet(editor, snippet)) {
    // 贡献缺失（Monaco 升级异常）：回退为默认 tab，不吞键
    editor.trigger("keyboard", "tab", null);
  }
}
