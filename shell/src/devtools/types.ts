// 开发工具（DevTool）协议：定义一套所有工具共同遵循的接入契约。
// 每个工具只需实现「一份元数据 + 一个 mount(host)」，其余（面板、菜单、复制、回填编辑器）
// 均由框架统一提供。后续新增工具无需改动面板/菜单代码，仅 register 即可。
//
// PR-1（devtools_plugin_dev_plan / plugin_system_design §9）：host 能力扩展 + kit UI 积木。
// 面向后续插件化的注意：v1 仍是同 realm 直调（内置工具），权限门控在 PR-2 落地；
// 本文件类型是未来 manifest 投影的运行时形状，字段演进须与 docs/plugin_system_design.md §9 对齐。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { t, type TFuncKey } from "../i18n"; // 第十七批 i18n：预置分组的展示名走语言包
import type { ToolKit } from "./kit";

export type MonacoModule = typeof MonacoApi;

/** 框架注入给工具的能力集合（工具仅通过 host 与外壳交互，不直接触碰全局状态） */
export interface ToolHost {
  /** 工具面板的内容容器，工具把自己的 DOM 挂到此处 */
  root: HTMLElement;
  /** 复用 Monaco（只读代码预览 / 值预览等） */
  monaco: MonacoModule;
  /** UI 积木（textarea / output / toolbar / 按钮 / copy/paste/clear / error） */
  kit: ToolKit;
  /** 当前工作区根（null = 未打开工作区；供「从文件读取」等场景使用） */
  workspaceRoot: () => string | null;
  /** 复制到剪贴板（统一走已有的 copy_to_clipboard IPC）；返回是否成功 */
  copyToClipboard: (text: string) => Promise<boolean>;
  /** 读取剪贴板文本（clipboard-manager 插件）；失败或空返回 null */
  readClipboard: () => Promise<string | null>;
  /** 当前编辑器选区文本；无选区或无打开文件返回 null */
  getSelectedText: () => string | null;
  /** 用 text 替换当前编辑器选区（无选区时插入光标处）；无打开文件返回 false */
  replaceSelection: (text: string) => boolean;
  /** 把文本插入当前编辑器（选区处；无选区时插到文档末尾）；无打开文件时返回 false */
  insertToEditor: (text: string) => boolean;
}

/** 工具清单元数据 */
export interface DevTool {
  /** 唯一 id，如 "curl2python" */
  id: string;
  /** 面板 / 菜单中的显示名 */
  title: string;
  /** 用途说明（面板导航 hover 提示） */
  description: string;
  /** 分组名（面板导航按此分组；空串归入「其他」） */
  category: string;
  /** codicon 图标名（如 "terminal" / "json"） */
  icon: string;
  /** inline 变换入口显示名（manifest 的 inline.label 投影；null = 无 inline）。
   *  v1.1：Ctrl+Shift+T 上下文感知——编辑器有选区时 picker 过滤为 inline 工具并直接执行。 */
  inlineLabel: string | null;
  /** 打开工具：挂载 UI 到 host.root，返回清理句柄（可返回 null 表示无需清理） */
  mount(host: ToolHost): ToolInstance | void;
}

/** 工具实例：面板切换 / 关闭时调用 dispose 清理（Monaco editor、事件监听器等） */
export interface ToolInstance {
  dispose(): void;
}

/** 预置 category 有序集（plugin_system_design §9.8）：菜单 / picker / 命令面板三处同源 */
export const PRESET_CATEGORIES = ["编码", "哈希", "格式化", "转换", "生成", "提取", "文本", "其他"] as const;

/** category 排序键：预置值按预置序（0..6）；自定义值档位 7（按字母序）；「其他」恒最后（99） */
export function categoryOrderKey(category: string): [number, string] {
  const i = (PRESET_CATEGORIES as readonly string[]).indexOf(category);
  if (i === PRESET_CATEGORIES.length - 1) return [99, ""]; // 「其他」垫底
  if (i >= 0) return [i, ""];
  return [PRESET_CATEGORIES.length - 1, category]; // 自定义：在「文本」后、「其他」前
}

/** 预置分组的语言包 key（manifest.category 存中文原文作恒定标识，展示时经此翻译） */
const CATEGORY_KEYS: Record<string, string> = {
  编码: "devtools.cat.encoding",
  哈希: "devtools.cat.hash",
  格式化: "devtools.cat.format",
  转换: "devtools.cat.convert",
  生成: "devtools.cat.generate",
  提取: "devtools.cat.extract",
  文本: "devtools.cat.text",
  其他: "devtools.cat.other",
};

/** 分组展示名：预置分组取当前语言词条；自定义分组（第三方 manifest 自带）原样返回 */
export function categoryLabel(category: string): string {
  const key = CATEGORY_KEYS[category] as TFuncKey | undefined;
  return key ? t(key) : category;
}

/** 工具列表按（category 排序键, 注册序）分组：返回有序 [category, tools] 数组；空 category 归「其他」 */
export function groupToolsByCategory(tools: DevTool[]): Array<[string, DevTool[]]> {
  const groups = new Map<string, DevTool[]>();
  for (const t of tools) {
    const cat = t.category?.trim() || "其他";
    const list = groups.get(cat);
    if (list) list.push(t);
    else groups.set(cat, [t]);
  }
  return [...groups.entries()].sort((a, b) => {
    const [ai, as] = categoryOrderKey(a[0]);
    const [bi, bs] = categoryOrderKey(b[0]);
    if (ai !== bi) return ai - bi;
    return as.localeCompare(bs, "zh");
  });
}
