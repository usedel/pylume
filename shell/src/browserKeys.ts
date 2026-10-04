// 浏览器原生快捷键护栏（补 editorFind.ts 之外的全局兜底）。
//
// 背景：Ctrl+F 之外还有一批 WebView2 的「浏览器加速器键」（AreBrowserAcceleratorKeysEnabled
// 默认开启）。前端无人 preventDefault 时，WebView2 会执行浏览器动作——轻则弹打印/查找条，
// 重则 Ctrl+R 重载、Ctrl+W 关窗口、Ctrl+Shift+Delete 清浏览数据，对 IDE 外壳全是灾难。
// 二类泄漏（更隐蔽）：main.ts 的 window 级键位分发在焦点位于 INPUT/TEXTAREA 时整段 return，
// 于是侧栏搜索框里按 Ctrl+S 会变成「保存网页」、Ctrl+Shift+R 变成「硬刷新」。
//
// 策略（capture 阶段，赶在浏览器与各面板之前）：
//  1. 应用**未认领**的浏览器加速器 → preventDefault + stopPropagation（彻底吞掉）；
//  2. 应用**已认领**的（键位表 window 级，含危险键被用户改键认领的情况）→ 只 preventDefault、
//     不 stopPropagation：动作仍由 main.ts 原来的分发执行，但焦点在输入框时也不会漏给浏览器；
//  3. 焦点在 Monaco 内时只拦「Monaco 与键位表都不认领」的危险组合（Ctrl+R/Ctrl+P/…），
//     其余交回 Monaco——否则会误伤它的 Ctrl+D / Ctrl+K 和弦 / F3 等自带键位；
//  4. 焦点在设置面板「按键录入」框（.kb-capture）中 → 只 preventDefault、不 stopPropagation：
//     危险键（Ctrl+W 等）也要送进录入框成键，否则用户无法把此类键设为自定义键位。
//     两个放行口的判定收口在纯函数 shouldSwallowGuardEvent（单测覆盖）。

import * as kb from "./keybindings";

/** 事件 → 组合签名（与 keybindings.ts 的 eventMatches 同口径：Ctrl 与 Cmd 归一，主键取物理 code） */
export function comboOf(e: KeyboardEvent): string | null {
  if (!e.code) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(e.code);
  return parts.join("+");
}

/** 危险级：即使焦点在 Monaco 内也要拦（Monaco 不认领，落浏览器即破坏性动作） */
const DANGER = new Set([
  "Ctrl+KeyR",   // 重载
  "Ctrl+F5",     // 硬重载（F5 是调试键，不拦）
  "Ctrl+KeyP",   // 打印
  "Ctrl+KeyO",   // 打开文件
  "Ctrl+KeyU",   // 查看源代码
  "Ctrl+KeyN",   // 新窗口
  "Ctrl+KeyT",   // 新标签
  "Ctrl+KeyW",   // 关窗口/标签
  "Ctrl+Shift+KeyW",
  "Ctrl+Shift+KeyQ",
  "Ctrl+Shift+Delete", // 清除浏览数据
  "F7",               // 插入符浏览（页面变光标模式）
  "Alt+ArrowLeft",    // 浏览器后退
  "Alt+ArrowRight",   // 浏览器前进
]);

/** 焦点不在 Monaco 时追加拦截（编辑器内这些键由 Monaco 认领：Ctrl+D 复制行 / F3 查找下一个…） */
const OUTSIDE_MONACO = new Set([
  ...DANGER,
  "F3",
  "Shift+F3",
  "Ctrl+Shift+KeyG",
  "Ctrl+KeyD", // 浏览器加书签（编辑器内 = 复制行）
  "Ctrl+KeyH", // 浏览器历史（编辑器内 = 替换）
  "Ctrl+KeyJ", // 浏览器下载（编辑器内 = Live Templates 面板）
  "Ctrl+KeyK", // 浏览器地址栏搜索（编辑器内 = Monaco 和弦前缀）
  "Ctrl+KeyL", // 浏览器地址栏
  "Ctrl+Shift+KeyB", // 书签栏
  "Ctrl+Shift+KeyO", // 书签管理器
  "Ctrl+Shift+KeyD", // 全部加书签
  "Ctrl+Shift+KeyM", // 切换配置文件
  "Ctrl+Shift+KeyS", // Edge 网页捕获
  "F12",             // DevTools（编辑器内 = 跳转定义）
]);

/** 生产版追加：DevTools 快捷键（dev 版保留以便调试；生产版 wry 已禁用 devtools，拦了也是空操作）
 *  Ctrl+Shift+C 不拦——预留给终端复制。 */
const PROD_ONLY = new Set(["Ctrl+Shift+KeyI", "Ctrl+Shift+KeyJ"]);

/** 该组合是否应被护栏吞掉（纯函数，便于单测；inMonaco = 焦点在 Monaco 内） */
export function isBlockedCombo(combo: string, inMonaco: boolean): boolean {
  if (inMonaco) return DANGER.has(combo);
  if (OUTSIDE_MONACO.has(combo)) return true;
  return import.meta.env.PROD && PROD_ONLY.has(combo);
}

/**
 * 危险键中**已被应用认领**的（P1：智能选区 Ctrl+W / Ctrl+Shift+W）。
 *
 * 这些键若彻底 stopPropagation，Monaco 就收不到，我们注册的键位形同虚设；
 * 若完全不拦，一旦键位被用户改掉或编辑器未聚焦，落浏览器就是「关闭窗口」的灾难。
 * 折中：**仍然 preventDefault（浏览器永不执行关闭动作），但放行事件继续传播**给
 * Monaco —— 由编辑器的键位规则决定执行什么，无人认领时也只是空操作，无害。
 */
const CLAIMED_IN_MONACO = new Set(["Ctrl+KeyW", "Ctrl+Shift+KeyW"]);

/** 该组合在 Monaco 内是否只阻断浏览器、放行给编辑器（纯函数，便于单测） */
export function isClaimedInMonaco(combo: string, inMonaco: boolean): boolean {
  return inMonaco && CLAIMED_IN_MONACO.has(combo);
}

/**
 * 护栏是否应**吞掉事件**（stopPropagation，连应用自己的分发也不给）。
 * 两个放行口（仍 preventDefault 阻断浏览器动作，只是事件继续传播）：
 * - captureMode：焦点在设置面板「按键录入」框中——组合键要送进录入框成键；
 * - windowClaimed：危险组合已被某条 window 级键位认领（如用户把关闭标签改成 Ctrl+W）——
 *   事件放行给 main.ts 的 window 分发执行动作。
 */
export function shouldSwallowGuardEvent(
  combo: string,
  inMonaco: boolean,
  captureMode: boolean,
  windowClaimed: boolean,
): boolean {
  if (captureMode) return false;
  if (!isBlockedCombo(combo, inMonaco)) return false;
  return !isClaimedInMonaco(combo, inMonaco) && !windowClaimed;
}

/** 焦点是否在 Monaco 编辑器内（主编辑器 / diff / 本地历史 / 查找条都算） */
function focusInMonaco(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  return !!ae?.closest?.(".monaco-editor");
}

/** 焦点是否在快捷键「按键录入」框中（settingsPanel 聚焦时挂 kb-capture class） */
function focusInKeybindingCapture(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  return !!ae?.classList?.contains("kb-capture");
}

/** 安装 window 级捕获监听（幂等由调用方保证：main.ts 接线区只调一次） */
export function installBrowserKeyGuard(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      const combo = comboOf(e);
      if (!combo) return;
      const inMonaco = focusInMonaco();
      // 危险键已被 window 级键位认领（如 close_tab=Ctrl+W）：preventDefault 后放行给 main.ts 分发
      const windowClaimed = kb.matchWindowBinding(e) !== null;
      if (shouldSwallowGuardEvent(combo, inMonaco, focusInKeybindingCapture(), windowClaimed)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // 应用认领的组合（window 级 + Monaco 内已认领的智能选区键 Ctrl+W/Ctrl+Shift+W）：
      // 只阻断浏览器动作，事件继续传播给应用分发（Monaco 内由其键位规则决定动作）；
      // 非认领组合一律不动（否则普通输入框打字会被 preventDefault 吞掉）。
      // 注：isClaimedInMonaco 的组合必须 preventDefault——否则「放行给 Monaco」变成
      // 「放行给 WebView2」，无人认领时浏览器直接执行关闭窗口（E-BASIC-3 实测回归）。
      if (windowClaimed || isClaimedInMonaco(combo, inMonaco)) {
        e.preventDefault();
      }
    },
    true,
  );
}
