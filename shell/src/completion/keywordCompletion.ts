// 零引擎静态关键字补全（P3）：给「没有 LSP 引擎的语言」提供最基本的补全兜底。
//
// 数据来源：monaco-editor 自带 basic-languages Monarch 定义里的 `language.keywords`
// （经 tools/extract-keywords.mjs 提取为 keywords.gen.ts，零手工维护、零运行时依赖）。
//
// 与补全四段合并契约的关系（见 .codebuddy/rules/typescript-code-style「补全四层合并」）：
//   0xx 智能模板 / 1xx 运行时 intel / 2xx 静态引擎 → 关键字取**最低的 3xx 段**，永不抢先。
//   数据不含 python：Python 已由上述三段负责，再叠一份关键字会在弹窗里产生重复项。
//
// 边界：不新增进程 / worker / 依赖，纯内存查表（631 条量级），符合零 worker 与开销红线。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { KEYWORDS, KEYWORD_LANGUAGES } from "./keywords.gen";
import { t } from "../i18n"; // 第十六批 i18n：补全 detail 走语言包

type Monaco = typeof MonacoApi;

/** 替换范围：与 Monaco `IRange` 同构，但不引用 Monaco 类型，便于纯函数单测 */
export interface KeywordRange {
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
}

/** 关键字补全项（不含 kind——枚举需在 provider 回调内动态读取，见下） */
export interface KeywordItem {
  label: string;
  insertText: string;
  sortText: string;
  detail: string;
  range: KeywordRange;
}

/** 段位前缀：三段契约（0xx/1xx/2xx）之后的最低优先级段 */
const SORT_PREFIX = "3";

/** 开关真值（设置项 `keyword_completion`；与 live-templates 的 `setForceShowAll` 同模式）。
 *  provider 只注册一次，关闭时在回调内短路返回空数组——不做 dispose/重注册。 */
let enabled = true;

/** 运行时应用开关（init 读设置一次；设置保存路径再调一次——「恢复默认」不派发 change 事件，走不到即时监听器） */
export function setKeywordCompletionEnabled(v: boolean): void {
  enabled = v;
}

/**
 * 纯函数：给定语言 ID 与替换范围，产出该语言的关键字补全项。
 * 未知语言 / 未提取到关键字（含 python）返回空数组——provider 据此天然短路。
 */
export function keywordItems(languageId: string, range: KeywordRange): KeywordItem[] {
  const words = KEYWORDS[languageId];
  if (!words || words.length === 0) return [];
  const items: KeywordItem[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    items.push({
      label: word,
      insertText: word,
      // 段内按数据顺序（字典序）升序，与 live-templates 的 `0xx` 段写法一致
      sortText: SORT_PREFIX + String(i).padStart(3, "0"),
      detail: t("ide.completionKeyword"),
      range,
    });
  }
  return items;
}

/**
 * 注册关键字补全 provider（语言集合 = 已提取到关键字的语言）。
 *
 * 不设 triggerCharacters：字母/下划线由 Monaco 自动触发；若设 `.`，会在成员访问时弹出
 * 一堆关键字，且与 live-templates「`.` 后让位后缀补全」的分流逻辑冲突（P1-BUG-002 语义）。
 */
export function registerKeywordCompletion(monaco: Monaco): MonacoApi.IDisposable {
  return monaco.languages.registerCompletionItemProvider([...KEYWORD_LANGUAGES], {
    provideCompletionItems(model, position): MonacoApi.languages.ProviderResult<MonacoApi.languages.CompletionList> {
      if (!enabled) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const items = keywordItems(model.getLanguageId(), {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      });
      if (items.length === 0) return { suggestions: [] };

      // 踩坑 #1（同 live-templates/completion.ts）：Monaco 动态加载时序下，枚举必须在
      // 补全回调内读取 + 数值回退，模块顶层快照可能拿不到。
      const KIND_KEYWORD =
        (monaco.languages.CompletionItemKind && monaco.languages.CompletionItemKind.Keyword) ?? 17;

      // 不设 preselect：关键字是兜底项，不得抢走补全焦点。
      const suggestions: MonacoApi.languages.CompletionItem[] = items.map((it) => ({
        label: it.label,
        kind: KIND_KEYWORD,
        insertText: it.insertText,
        detail: it.detail,
        sortText: it.sortText,
        range: it.range,
      }));
      return { suggestions };
    },
  });
}
