// Pylume 开发工具插件 · 类型声明（P1 DX）
// ---------------------------------------------------------------------------
// 用法：插件目录里的 entry 文件首行写 `// @ts-check`，VS Code（或其他 TS 语言服务）
// 即对本文件提供的类型做补全与检查；无需安装任何依赖。
// 本文件随脚手架落盘到插件目录（pylume-plugin.d.ts），JSDoc 里的类型引用
// （host: ToolHost）由同目录声明解析。
// 规范源：docs/plugin_system_guide（devtools_plugin_guide.md）与 shell/src/extensions/facade.ts。
// 修改 API 时须同步这里与指南——三处（实现/声明/文档）漂移即坏。
// ---------------------------------------------------------------------------

/** 可选动作按钮（toast 右侧，点击即收起并执行） */
declare interface ToastAction {
  label: string;
  run(): void;
}

/** 面板模式与 inline 模式共有的能力（BaseHost，见 facade.ts） */
declare interface ToolHost {
  /** 轻提示（自动消失：info 4s / ok 3s / error 8s） */
  toast(msg: string, kind: "info" | "ok" | "error", action?: ToastAction): void;
  /** 调试日志：写入 设置 → 插件 → 日志面板。release 版没有控制台，这是唯一输出通道 */
  log(msg: string): void;
  /** 复制到系统剪贴板（需要 "clipboard" 权限） */
  copyToClipboard(text: string): Promise<boolean>;
  /** 读剪贴板文本，失败返回 null（需要 "clipboard" 权限） */
  readClipboard(): Promise<string | null>;
  /** 当前编辑器选区文本；无选区返回 null（需要 "selection" 权限） */
  getSelectedText(): string | null;
  /** 替换当前选区为 text；无选区时插入光标处（需要 "selection" 权限） */
  replaceSelection(text: string): boolean;
  /** 插入文本到当前编辑器（选区处；无选区插到文档末尾）（需要 "selection" 权限） */
  insertToEditor(text: string): boolean;
  /** 插件私有持久化（需要 "storage" 权限）；命名空间自动隔离（pylume.plugin.<id>.） */
  storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    clear(): void;
  };
  /** 工作区根绝对路径；未打开工作区返回 null（需要 "fs:read" 权限） */
  workspaceRoot(): string | null;
  /** 读插件目录内的相对路径文件（路径越界拒绝）（需要 "fs:read" 权限） */
  readFile(rel: string): Promise<string>;
  /** 工具面板内容容器（仅面板模式；inline 模式的 host 无此属性） */
  root: HTMLElement;
  /** UI 积木（仅面板模式；inline 模式的 host 无此属性） */
  kit: ToolKit;
  /** 裸 Monaco 模块（仅面板模式；须在 manifest 声明 "monaco" 权限——一般用 kit.output 即可） */
  monaco?: typeof import("monaco-editor");
}

/** UI 积木（见 shell/src/devtools/kit.ts 的 ToolKit） */
declare interface ToolKit {
  /** 根容器（flex column + gap），挂到 host.root */
  body(): HTMLElement;
  /** 横向行；字符串 "spacer" 为撑开占位 */
  row(...els: (HTMLElement | "spacer")[]): HTMLElement;
  /** 工具栏（可换行） */
  toolbar(...items: (HTMLElement | "spacer")[]): HTMLElement;
  /** codicon 图标 span */
  icon(name: string): HTMLElement;
  /** 互斥单选组（方向/算法等二选一；方向键移动即选中） */
  radioGroup<T extends string>(opts: {
    label: string;
    options: ReadonlyArray<{ value: T; label: string }>;
    value: T;
    onChange?: (value: T) => void;
  }): { el: HTMLElement; get(): T };
  /** 多行输入（自动 autocomplete=off + spellcheck=false） */
  textarea(opts?: { placeholder?: string; rows?: number; flex?: boolean; onInput?: (v: string) => void }): HTMLTextAreaElement;
  /** 单行输入 */
  input(opts?: {
    placeholder?: string;
    type?: "text" | "number";
    readOnly?: boolean;
    onInput?: (v: string) => void;
    onEnter?: (v: string) => void;
  }): HTMLInputElement;
  /** Monaco 输出封装（自动跟随用户字号/主题/减少动画；dispose 随工具释放） */
  output(opts?: { language?: string; readOnly?: boolean; placeholder?: string }): {
    el: HTMLElement;
    get(): string;
    set(text: string): void;
    clear(): void;
    dispose(): void;
  };
  button(label: string, icon?: string, onClick?: (ev: MouseEvent) => void): HTMLButtonElement;
  primaryButton(label: string, icon?: string, onClick?: (ev: MouseEvent) => void): HTMLButtonElement;
  iconButton(icon: string, tip: string, onClick?: (ev: MouseEvent) => void): HTMLButtonElement;
  /** 复制按钮（内置成功/失败反馈） */
  copyButton(getText: () => string): HTMLButtonElement;
  /** 粘贴按钮（读剪贴板写入 setText） */
  pasteButton(setText: (t: string) => void): HTMLButtonElement;
  /** 清空按钮（清空所有目标值） */
  clearButton(...targets: (HTMLTextAreaElement | HTMLInputElement | { clear(): void })[]): HTMLButtonElement;
  /** 错误提示槽（红字，占位高度防跳动） */
  errorSlot(): HTMLElement;
  /** 按钮 flash 反馈（"ok" 绿 / "error" 红） */
  flash(btn: HTMLButtonElement, kind: "ok" | "error", text: string): void;
}

/** 工具实例句柄：面板关闭/切换/热重载时调用 dispose 清理（Monaco/定时器/监听器） */
declare interface ToolInstance {
  dispose(): void;
}
