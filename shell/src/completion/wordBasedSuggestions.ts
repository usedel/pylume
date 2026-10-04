// 阶段 4：按语言开/关 Monaco 内建 word-based suggestions（文档词补全）。
//
// 背景：main.ts 建主编辑器时全局设 `wordBasedSuggestions: "off"`（踩坑 #3）——文档词建议会与
// pyrefly / intel 的语义补全混排，淹掉真正有用的结果。但对**没有 LSP 引擎的语言**
// （json / yaml / toml / sql / rust / …）它是唯一的标识符补全来源，恒关纯亏。
// 本模块的处理：跟随「活动模型的语言」动态切换——python 恒 `"off"`，其余语言取当前文档的词。
//
// 为什么取 "currentDocument" 而非 "matchingDocuments"：前者只把当前文档同步进 editor worker，
// 后者会把所有同语言 model 一并同步（worker 内存随打开文件数增长）。本项目「零 worker / 开销红线」
// 取保守档；要跨文件取词只需改本文件一个常量。词提取全部由既有 editor worker 完成
// （suggestController 已引入），不自研词表、不新增 worker。
//
// ⚠ 作用范围：Monaco standalone 下编辑器选项是**全局**的——
//   StandaloneEditor.updateOptions → updateConfigurationService（standaloneCodeEditor.js:214）
//     → StandaloneConfigurationService.updateValues（standaloneServices.js:517-535），
//   而词补全 provider 经 ITextResourceConfigurationService 读同一份全局值
//   （editorWorkerService.js:168-193）。
//   故该开关会一并作用于 git / localHistory 的 diff 宿主（跟随主编辑器当前文件的语言）——
//   这是 standalone 的固有语义，无法只作用于主编辑器，此处只做「按语言取值」，不作作用域假设。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { DisposableStore } from "../util";

/** 有语义引擎负责补全的语言：词建议恒关（否则与 0xx/1xx/2xx 三段混排） */
const ENGINE_BACKED: ReadonlySet<string> = new Set(["python"]);

/** 非引擎语言的取值：只取当前文档的词（保守档，见文件头） */
const NON_ENGINE_VALUE = "currentDocument";

export type WordBasedSuggestionsMode = "off" | typeof NON_ENGINE_VALUE;

/** 纯函数：语言 ID → word-based suggestions 取值（不依赖 Monaco，便于单测）。
 *  无 model（languageId 为空）按非引擎档——空编辑器不会触发补全，取值无实际影响。 */
export function wordBasedSuggestionsFor(languageId: string | null | undefined): WordBasedSuggestionsMode {
  return languageId && ENGINE_BACKED.has(languageId) ? "off" : NON_ENGINE_VALUE;
}

/** 接线：跟随活动模型语言切换。仅在取值变化时 updateOptions——切 tab 频繁，
 *  无变化时不该反复戳全局配置服务（会连带触发所有编辑器的选项重算）。 */
export function wireWordBasedSuggestions(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  const store = new DisposableStore();
  let current: WordBasedSuggestionsMode | null = null;
  const apply = (): void => {
    const next = wordBasedSuggestionsFor(editor.getModel()?.getLanguageId());
    if (next === current) return;
    current = next;
    editor.updateOptions({ wordBasedSuggestions: next });
  };
  store.add(editor.onDidChangeModel(() => apply())); // 开文件 / 切 tab（setModel）
  store.add(editor.onDidChangeModelLanguage(() => apply())); // 同一模型语言被改写（setModelLanguage）
  apply(); // 初始：建编辑器时 model 为 null ⇒ 非引擎档
  return store;
}
