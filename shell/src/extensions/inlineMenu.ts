// 编辑器右键「变换选区 ▸」子菜单（plugin_system_design §9.9 / §9.15；v1 验收遗留 P2 项）。
//
// 为什么不用 editor.addAction：Monaco 的 addAction（contextMenuGroupId）只能挂平级菜单项，
// 不支持子菜单；「变换选区」下有 N 个 inline 工具，平铺会淹没既有右键项。
// 正路是 MenuRegistry.appendMenuItem(MenuId.EditorContext, { submenu })：
// - contextmenu.js::_getMenuActions 会递归展开 submenu（空子菜单自动不渲染父项）；
// - menu.js::SubmenuMenuActionViewItem 渲染 flyout，键盘/鼠标交互由 Monaco 内建。
//
// 动态性：子项数据源是插件注册表（inline 工具随插件热重载/启停增减），而 MenuRegistry
// 没有「改子菜单内容」的 API——只能 revoke（dispose）旧条目再 append。onRegistryChanged
// 时整体重建子项（注册表通知已去抖合并，一个插件 N 工具只触发一次）。
//
// 显示条件：Monaco 内建 context key `editorHasSelection`（editorContextKeys.js，右键时由
// 编辑器维护）——无选区时父项与子项均隐藏，与「无选区 → runInline toast 提示」兜底一致。
//
// 分屏：MenuId.EditorContext 是全局注册表，主/副编辑器同生效；runInline 内部读
// app.editor（主编辑器）选区，与命令面板入口同一语义。

import { ContextKeyExpr } from "monaco-editor/esm/vs/platform/contextkey/common/contextkey";
import { MenuId, MenuRegistry } from "monaco-editor/esm/vs/platform/actions/common/actions";
import { CommandsRegistry } from "monaco-editor/esm/vs/platform/commands/common/commands";
import { DisposableStore } from "../util";
import { onRegistryChanged } from "../devtools/registry";
import { setInlineRunner } from "../devtools/panel";
import { listInlineEntries, runInline } from "./inline";
import { listPluginRecords } from "./loader";
import { t } from "../i18n"; // 第十六批 i18n：右键菜单标题走语言包

/** 右键「变换选区」子菜单 id（MenuId 实例须全局唯一，new 私有实例） */
const TRANSFORM_SUBMENU = new MenuId("pylume.editorContext.transformSelection");

/** 子菜单 command id 前缀（CommandsRegistry 全局注册，须与菜单条目 id 一致） */
const INLINE_CMD_PREFIX = "pylume.inline.";

/** 应用级 disposable（lspProviders 范式：测试 teardown / 重复 init 防泄漏累积） */
const inlineMenuDisposables = new DisposableStore();

/** 注册编辑器右键「变换选区 ▸」子菜单（main.ts init 接线一次） */
export function initInlineSelectionMenu(): void {
  const store = new DisposableStore();

  // 父项挂 navigation 组尾部（1.95：排在正则测试器 1.8 / JSON 三项 1.85-1.87 之后）
  store.add(
    MenuRegistry.appendMenuItem(MenuId.EditorContext, {
      submenu: TRANSFORM_SUBMENU,
      title: t("ext.transformSelectionMenu"),
      group: "navigation",
      order: 1.95,
      when: ContextKeyExpr.deserialize("editorHasSelection"),
    }),
  );

  // 子菜单条目 = 当前激活插件的全部 inline 入口；注册表变更时整体重建
  //（util.DisposableStore 无 clear：子 store 每次 dispose 后换新实例，语义等价且防漏清）
  const subStore = new DisposableStore();
  store.add(subStore);
  const cmdStore = new DisposableStore();
  store.add(cmdStore);
  const syncItems = (): void => {
    subStore.dispose();
    cmdStore.dispose();
    for (const entry of listInlineEntries(listPluginRecords(), true)) {
      const cmdId = INLINE_CMD_PREFIX + entry.toolId;
      cmdStore.add(
        CommandsRegistry.registerCommand(cmdId, () => {
          void runInline(entry.toolId);
        }),
      );
      subStore.add(
        MenuRegistry.appendMenuItem(TRANSFORM_SUBMENU, {
          command: { id: cmdId, title: entry.label },
          // 子项同样受选区门控（展开是惰性的，但求值时机不可控，双保险）
          when: ContextKeyExpr.deserialize("editorHasSelection"),
        }),
      );
    }
  };
  store.addCallback(onRegistryChanged(syncItems));
  syncItems();

  // v1.1（§9.9 上下文感知）：picker 的 inline 模式选中项直接执行变换（panel 注入点接线）
  setInlineRunner((toolId) => void runInline(toolId));

  // 应用级生命周期：与 lspProviders 同模式的 teardown 收口（重复 init 先清旧，防泄漏累积）
  inlineMenuDisposables.dispose();
  inlineMenuDisposables.add(store);
}
