// 开发工具框架入口（PR-3）：内置工具以「内置插件」形态注册（§9.7 dogfooding），
// 与第三方插件走完全相同的注册路径（loader.registerBuiltinPlugin → registry），
// 面板导航与「工具」菜单自动生成对应入口。
//
// 新增内置工具只需：在 devtools/builtin/ 下写模块（mount + 可选 inline handler），
// 再在 builtin/index.ts 的 buildBuiltinManifest 与 BUILTIN_TOOL_MODULES 各加一行。

import { $ } from "../state";
import { onLocaleChange } from "../i18n"; // 第十七批 i18n：语言切换重注册内置工具（刷新 manifest 展示文案）
import { createToolHost, type DevToolsHostDeps } from "./host";
import { initDevToolsPanel } from "./panel";
import { registerBuiltinPlugin } from "../extensions/loader";
import { buildBuiltinManifest, BUILTIN_TOOL_MODULES } from "./builtin";

export { openDevTools, closeDevTools, openDevToolsPanel } from "./panel";
export { listDevTools } from "./registry";
export { groupToolsByCategory, PRESET_CATEGORIES, categoryLabel } from "./types";

/** 语言切换重注册只挂一次（重复调用 registerBuiltinTools 不重复订阅） */
let localeSubscribed = false;

/** 注册内置工具插件（幂等；devtools/index.ts 与 main.ts 均可安全调用） */
export function registerBuiltinTools(): void {
  registerBuiltinPlugin(buildBuiltinManifest(), BUILTIN_TOOL_MODULES as Record<string, never>);
  if (!localeSubscribed) {
    localeSubscribed = true;
    // 切语言后重注册：DevTool 的 title/description/inlineLabel 在注册时定格（loader 投影 manifest），
    // 重注册让 registry 拿到新语言的元数据；面板/菜单监听 registry 变更自动重绘。
    // registerBuiltinPlugin 幂等（先注销后注册），且尊重用户的插件停用状态。
    onLocaleChange(() => registerBuiltinPlugin(buildBuiltinManifest(), BUILTIN_TOOL_MODULES as Record<string, never>));
  }
}

/** 初始化框架：注册内置工具并接线面板（须在 DOM 就绪后调用一次） */
export function initDevTools(deps: DevToolsHostDeps): void {
  registerBuiltinTools();
  initDevToolsPanel(createToolHost($("devtools-body"), deps));
}
