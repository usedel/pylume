// 欢迎页快捷键网格（UI-25）：内容由键位系统动态渲染。
//
// 原先 index.html 里是 6 行硬编码 <kbd>，而 keybindings.ts + 设置面板「快捷键」分类早已支持用户改键。
// 运行组 tooltip（runWidget.ts）与调试工具栏提示（debugView.ts，第四批 UI-09 顺带修掉）都已改读
// bindingLabel()——欢迎页是最后一处漏网的：用户改键后这里仍显示出厂默认值，与实际键位不符。
//
// 归属：不落在 main.ts（TD-014 已登记 main.ts 待拆分；UI 改进计划约束「不得继续往 main.ts 堆逻辑」）。
// main.ts 只在 updateEditorOverlay 里调一次 renderWelcomeShortcuts()，settingsPanel 保存后调一次，
// 与既有的 repaintRunWidget() 同模式。
//
// 两类条目的区分（勿误以为是漏改）：
// - kb：键位系统里有条目的动作 → 读用户当前键位，改键即跟随；
// - fixed：Monaco 内建、不在键位系统内的动作（查找引用 / 格式化文档）→ 只能是固定值。
//   哪天把它们纳入键位系统，改成 kb 字段即可，渲染逻辑无需改动。

import { $ } from "./state";
import { bindingChord, bindingLabel, type KeybindingId } from "./keybindings";
import { onLocaleChange, t } from "./i18n"; // 第九批 i18n：欢迎域动态文案走语言包

interface WelcomeShortcut {
  /** 说明文字（右侧灰字） */
  label: string;
  /** 键位系统条目 id（与 fixed 二选一） */
  kb?: KeybindingId;
  /** kb 被解绑时的兜底键位。「跳转到定义」的 F12 由 Monaco 固定保留（见 KEYBINDING_META 的 label 说明），
   *  即使用户把 Ctrl+B 解绑，F12 仍然可用，故此时不该显示「未绑定」。 */
  fallback?: string;
  /** 不在键位系统内的固定键位（Monaco 内建，不可配置） */
  fixed?: string;
}

/** P1（UX 审查）：由 6 行扩充到 13 行——键位系统里 30+ 项大多无处可发现，
 *  欢迎页是首屏唯一键位入口。仍保持「kb 优先 + fixed 兜底」两类结构。 */
// i18n：构建函数 + let 缓存，语言切换时重建（见下方订阅）
function buildShortcuts(): WelcomeShortcut[] { return [
  { label: t("welcome.shortcuts.save"), kb: "save" },
  { label: t("welcome.shortcuts.globalSearch"), kb: "global_search" },
  // v3.4 §17-7（M3-3.5）：run 拆为 run_script + run_project
  { label: t("welcome.guide.qsRunScript"), kb: "run_script" },
  { label: t("welcome.shortcuts.runProject"), kb: "run_project" },
  { label: t("welcome.shortcuts.gotoDefinition"), kb: "goto_definition", fallback: "F12" },
  { label: t("welcome.shortcuts.findReferences"), fixed: "Shift+F12" },
  { label: t("welcome.shortcuts.formatDocument"), fixed: "Shift+Alt+F" },
  { label: t("welcome.guide.qsDebug"), kb: "debug" },
  { label: t("welcome.shortcuts.closeTab"), kb: "close_tab" },
  // PR-A（dx_features_backlog §6.1）：键位补齐组的高频两项
  { label: t("welcome.shortcuts.deleteLine"), kb: "delete_line" },
  { label: t("welcome.shortcuts.reopenTab"), kb: "reopen_tab" },
  // PR-D（dx_features_backlog §6.4）：最近编辑位置
  { label: t("welcome.shortcuts.recentEditLocations"), kb: "recent_edit_locations" },
  { label: t("welcome.shortcuts.newFile"), kb: "new_file" },
  { label: t("welcome.shortcuts.gotoFile"), kb: "goto_file" },
  // PR-G（dx_features_backlog §6.6）：文件内符号 Quick Pick
  { label: t("welcome.shortcuts.gotoSymbol"), kb: "goto_symbol" },
  // PR-J（dx_features_backlog §6.6）：触发补全建议备选键（Ctrl+Space 被中文 IME 吞键，人工验证）
  { label: t("welcome.shortcuts.triggerSuggest"), kb: "trigger_suggest" },
  { label: t("welcome.shortcuts.navBack"), kb: "nav_back" },
  { label: t("welcome.shortcuts.recentFiles"), kb: "recent_files" },
  { label: t("welcome.shortcuts.openSettings"), kb: "open_settings" },
];
}
let SHORTCUTS = buildShortcuts();
// 语言切换：重建标签并重绘网格（元素缺失时跳过——欢迎层未挂载即无文本残留）
onLocaleChange(() => {
  SHORTCUTS = buildShortcuts();
  if (document.getElementById("ew-shortcuts")) renderWelcomeShortcuts();
});

/** 该项当前应显示的键位串（空串 = 已解绑且无兜底） */
function bindingOf(s: WelcomeShortcut): string {
  if (s.fixed) return s.fixed;
  if (!s.kb) return "";
  return bindingLabel(s.kb) || s.fallback || "";
}

/** 重绘快捷键网格（幂等：每次全量重建，6 行的成本可忽略）。
 *  调用点：main.ts::updateEditorOverlay（覆盖层显示时）、settingsPanel.ts::saveSettingsPanel（改键后）。 */
export function renderWelcomeShortcuts(): void {
  const grid = $("ew-shortcuts");
  grid.textContent = "";
  for (const s of SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "ew-shortcut";
    const chord = bindingChord(bindingOf(s));
    if (chord.length === 0) {
      // 解绑且无兜底：给明确占位。整行删掉会让用户以为「这个功能没了」，渲染空 kbd 框则是缺陷。
      const none = document.createElement("span");
      none.className = "ew-kbd-none";
      none.textContent = t("welcome.guide.unbound");
      row.appendChild(none);
    } else {
      for (const t of chord) {
        const kbd = document.createElement("kbd");
        kbd.textContent = t;
        row.appendChild(kbd);
      }
    }
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = s.label;
    row.appendChild(label);
    grid.appendChild(row);
  }
}
