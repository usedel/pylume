// 工具注册表：集中登记所有 DevTool，面板与菜单据此自动生成入口。

import type { DevTool } from "./types";

const tools = new Map<string, DevTool>();
/** 注册表变更监听（插件热重载/启停后通知 panel/菜单刷新） */
const listeners = new Set<() => void>();
/** 变更通知去抖（一个插件注册 N 个工具只触发一次刷新，避免 panel 反复全清缓存） */
let notifyTimer: number | undefined;

function scheduleNotify(): void {
  window.clearTimeout(notifyTimer);
  notifyTimer = window.setTimeout(() => {
    listeners.forEach((fn) => fn());
  }, 0);
}

/** 登记一个工具（重复 id 仅告警不覆盖） */
export function registerDevTool(tool: DevTool): void {
  if (tools.has(tool.id)) {
    console.warn(`[devtools] 重复注册工具 id=${tool.id}`);
    return;
  }
  tools.set(tool.id, tool);
  scheduleNotify();
}

/** 注销工具（插件停用/热重载用） */
export function unregisterDevTool(id: string): void {
  if (tools.delete(id)) {
    scheduleNotify();
  }
}

/** 订阅注册表变更（返回取消订阅函数） */
export function onRegistryChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 列出全部工具（插入序） */
export function listDevTools(): DevTool[] {
  return [...tools.values()];
}

/** 按 id 取工具 */
export function getDevTool(id: string): DevTool | undefined {
  return tools.get(id);
}