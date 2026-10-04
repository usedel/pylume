// ToolHost 实现：把外壳能力（剪贴板 IPC、编辑器选区、工作区根）适配成工具可见的统一接口。
// PR-1：补 readClipboard / getSelectedText / replaceSelection，并注入 kit（见 kit.ts）。
// 面向插件化（PR-2）：本文件是 facade 的内核前身；届时按 manifest.permissions 包一层门控。

import { invoke } from "@tauri-apps/api/core";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { createToolKit } from "./kit";
import type { MonacoModule, ToolHost } from "./types";

export interface DevToolsHostDeps {
  monaco: MonacoModule;
  editor: MonacoApi.editor.IStandaloneCodeEditor;
  workspaceRoot: () => string | null;
}

/** 读取剪贴板文本（clipboard-manager 插件；失败返回 null） */
export async function readClipboardText(): Promise<string | null> {
  try {
    const v = await invoke<string | null>("plugin:clipboard-manager|read_text");
    return v ?? null;
  } catch {
    return null;
  }
}

/** 以指定容器为 root 构造 ToolHost（root 每实例独立，kit 随之绑定） */
export function createToolHost(root: HTMLElement, deps: DevToolsHostDeps): ToolHost {
  // kit 引用 host（copy/paste 走 host 能力），host 字段又需 kit——用局部变量先声明后填充：
  // TS 要求初始化器里不能引用尚未赋值的 const，故 host 用「先声明 undefined、kit 构造后回填」。
  const host: ToolHost = {} as ToolHost;
  host.root = root;
  host.monaco = deps.monaco;
  host.workspaceRoot = deps.workspaceRoot;
  host.copyToClipboard = async (text: string) => {
    try {
      await invoke("copy_to_clipboard", { text });
      return true;
    } catch (e) {
      console.warn("[devtools] 复制失败", e);
      return false;
    }
  };
  host.readClipboard = () => readClipboardText();
  host.getSelectedText = () => {
    const model = deps.editor.getModel();
    const sel = deps.editor.getSelection();
    if (!model || !sel || sel.isEmpty()) return null;
    return model.getValueInRange(sel);
  };
  host.replaceSelection = (text: string) => {
    const model = deps.editor.getModel();
    if (!model) return false;
    const sel = deps.editor.getSelection();
    // 无选区时替换光标处空区间 = 原地插入
    const range = sel ?? new deps.monaco.Range(1, 1, 1, 1);
    deps.editor.executeEdits("devtools-replace", [{ range, text }]);
    deps.editor.focus();
    return true;
  };
  host.insertToEditor = (text: string) => {
    const model = deps.editor.getModel();
    if (!model) return false;
    // 无选区时插到文档末尾
    const sel = deps.editor.getSelection() ?? {
      startLineNumber: model.getLineCount(),
      startColumn: model.getLineMaxColumn(model.getLineCount()),
      endLineNumber: model.getLineCount(),
      endColumn: model.getLineMaxColumn(model.getLineCount()),
    };
    deps.editor.executeEdits("devtools", [{ range: sel, text }]);
    deps.editor.focus();
    return true;
  };
  host.kit = createToolKit(host); // 回填在最后：kit 构造时不解引用 host，仅在按钮回调时使用
  return host;
}
