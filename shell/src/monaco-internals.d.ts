// Monaco 内部深路径模块声明（monaco-editor npm 包未公开 .d.ts 的内部 API）。
// 仅用于 JSON 字面量折叠与缩进折叠的合并（jsonLiteral.ts，回归修复 2026-09-27）；
// monaco 版本锁 ci/versions.toml，升级走回归 CI——声明随实际 js 对齐。
declare module "monaco-editor/esm/vs/editor/contrib/folding/browser/indentRangeProvider" {
  export interface FoldingRangesLimit {
    limit: number;
    update(length: number, capped: boolean): void;
  }
  /** Monaco 内建缩进折叠器（folding strategy=auto 的 fallback 来源）；compute 返回 FoldingRegions */
  export class IndentRangeProvider {
    constructor(
      editorModel: unknown,
      languageConfigurationService: unknown,
      foldingRangesLimit: FoldingRangesLimit,
    );
    /** FoldingRegions：.length / getStartLineNumber(i) / getEndLineNumber(i)；token 参数未使用 */
    compute(cancelationToken?: never): Promise<{
      readonly length: number;
      getStartLineNumber(index: number): number;
      getEndLineNumber(index: number): number;
    }>;
  }
}

declare module "monaco-editor/esm/vs/editor/common/languages/languageConfigurationRegistry" {
  /** 服务标识（js 本体是 createDecorator 产物，这里只做类型透传） */
  export const ILanguageConfigurationService: { readonly _serviceBrand: undefined };
}

declare module "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices" {
  /** monaco standalone 的服务定位器（官方公开 API，但 npm 包未带 .d.ts） */
  export const StandaloneServices: { get(identifier: unknown): unknown };
}

// ---------- 编辑器右键「变换选区 ▸」子菜单（extensions/inlineMenu.ts，P2 2026-09-30） ----------
// 同版本锁纪律：声明与实际 js 对齐，monaco 升级走回归 CI。

declare module "monaco-editor/esm/vs/platform/actions/common/actions" {
  /** 菜单 id（MenuRegistry 全局注册表键）；new 实例即注册一个新菜单容器 */
  export class MenuId {
    constructor(id: string);
    readonly id: string;
  }
  export namespace MenuId {
    /** 编辑器右键菜单容器 */
    export const EditorContext: MenuId;
  }
  /** 菜单注册表：appendMenuItem 返回 revoke disposable */
  export const MenuRegistry: {
    appendMenuItem(id: MenuId, item: unknown): { dispose(): void };
  };
}

declare module "monaco-editor/esm/vs/platform/contextkey/common/contextkey" {
  /** 上下文键表达式（when 子句）；deserialize 解析 "a == b" 串 */
  export class ContextKeyExpr {
    static deserialize(serialized: string | undefined): ContextKeyExpr | undefined;
    static equals(key: string, value: unknown): ContextKeyExpr;
  }
}

declare module "monaco-editor/esm/vs/platform/commands/common/commands" {
  /** 命令注册表（MenuItemAction.run → commandService.executeCommand(id)） */
  export const CommandsRegistry: {
    registerCommand(
      id: string,
      handler: (accessor: unknown, ...args: unknown[]) => unknown,
    ): { dispose(): void };
  };
}
