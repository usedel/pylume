// inline 变换管线（PR-2，plugin_system_design §9.15）：选中 → 变换 → 原地替换 → 撤销 toast。
// 入口：命令面板「工具: <inline.label>」（main.ts）/ 编辑器右键「变换选区 ▸ <label>」（inlineMenu.ts，P2 落地）。

import { toast } from "../toast";
import { createInlineHost, type FacadeDeps, type InlineHost } from "./facade";
import { getInlineHandler, type PluginRecord } from "./loader";
import { pluginToolId } from "./manifest";
import { t } from "../i18n"; // 第十六批 i18n：inline 变换提示走语言包

/** inline 变换入口的描述（命令面板 / 右键菜单数据源） */
export interface InlineEntry {
  /** 工具全局键（pluginId.toolId） */
  toolId: string;
  /** 显示名（manifest inline.label） */
  label: string;
}

/** 命令面板条目名（§9.9 统一前缀） */
export function inlineCommandLabel(entry: InlineEntry): string {
  return t("ext.inlineCommandLabel", { label: entry.label });
}

/** 扫描全部插件记录，收集可用的 inline 入口 */
export function listInlineEntries(records: PluginRecord[], activeOnly: boolean): InlineEntry[] {
  const out: InlineEntry[] = [];
  for (const rec of records) {
    if (activeOnly && rec.status !== "active") continue;
    for (const tc of rec.manifest.contributes?.tools ?? []) {
      if (tc.inline) {
        out.push({ toolId: pluginToolId(rec.id, tc.id), label: tc.inline.label });
      }
    }
  }
  return out;
}

let facadeDeps: FacadeDeps | null = null;
let recordsProvider: () => PluginRecord[] = () => [];

/** 注入依赖（main.ts 启动接线一次） */
export function initInlineRunner(deps: FacadeDeps, getRecords: () => PluginRecord[]): void {
  facadeDeps = deps;
  recordsProvider = getRecords;
}

/** 执行一次 inline 变换（§9.15 时序）：无选区提示；handler 抛错保留原文；成功带撤销 */
export async function runInline(toolId: string): Promise<void> {
  if (!facadeDeps) return;
  const rec = recordsProvider().find((r) => toolId.startsWith(r.id + "."));
  if (!rec || rec.status !== "active") return;

  const host: InlineHost = createInlineHost(rec.manifest, rec.dir, facadeDeps);
  const handler = getInlineHandler(rec, toolId);
  if (!handler) return;

  const text = host.getSelectedText();
  if (text === null || text === "") {
    toast(t("ext.selectTextFirst"), "info");
    return;
  }

  let result: unknown;
  try {
    result = await handler.run(text, host);
  } catch (e) {
    toast(t("ext.transformFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
    return; // 保留原文
  }
  if (typeof result !== "string") {
    toast(t("ext.transformNotString"), "error");
    return;
  }

  const snapshot = text;
  if (!host.replaceSelection(result)) {
    toast(t("ext.replaceNoFile"), "error");
    return;
  }
  toast(t("ext.applied", { label: handler.label }), "success", {
    actionLabel: t("ext.undo"),
    onAction: () => {
      void host.replaceSelection(snapshot);
    },
  });
}
