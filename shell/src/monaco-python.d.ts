/**
 * monaco-editor basic-languages 的 grammar JS 无类型定义（TS7016）。
 * 这里只声明本项目静态引入的 python 语法定义（monaco.ts 静态绑定 Monarch，绕开
 * contribution 的运行时动态 import——见 monaco.ts 内注释）。
 */
declare module "monaco-editor/esm/vs/basic-languages/python/python.js" {
  import type * as languages from "monaco-editor/esm/vs/editor/editor.api";

  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
