// UI-30：弹出菜单的 ARIA 键盘导航（WAI-ARIA APG「menu」模式）。
//
// 为什么独立成模块而不是塞进 menu.ts：应用里有**两套并存的菜单渲染器**——
// menu.ts（#ctx-menu，扁平即时弹出）与 main.ts 菜单栏（#menu-dropdown + #menu-submenu，
// flyout 级联，分工说明见 menu.ts 头部注释，两套渲染器刻意不合并）。
// 但键盘导航语义（↑↓/Home/End 漫游、Enter/Space 激活、Tab 退出）对两套完全一致，
// 抽到本模块共享，避免同一套规则写两遍后各自漂移（第四批 syncHiddenFilesBtn 同款教训）。
//
// 约定：两套渲染器产出的菜单项均为 `.ctx-menu-item`，分隔符 `.sep-item`、禁用项 `.disabled`；
// 菜单项须由渲染器设 `tabindex="-1"`（程序可聚焦、不占 tab 序列）。

/** 可聚焦的菜单项集合：跳过分隔符与禁用项。
 *  禁用项键盘不可达与鼠标「点了没反应 + 置灰」语义一致（APG 允许两种处理，取跳过——
 *  让 ↑↓ 直达可用项，与 VS Code 行为一致）。 */
export function menuItemsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".ctx-menu-item:not(.sep-item):not(.disabled)"));
}

/** 在菜单内移动焦点：1=下一项 / -1=上一项（均环绕），"first"/"last"=首/末项。
 *  当前焦点不在菜单内时（如刚打开），dir=1 从首项开始、dir=-1 从末项开始。 */
export function moveMenuFocus(root: HTMLElement, dir: 1 | -1 | "first" | "last"): void {
  const items = menuItemsOf(root);
  if (items.length === 0) return;
  // preventScroll：菜单是 position:fixed 的浮层，若因聚焦触发浏览器"滚动到可见"，
  // 会连带滚动文档 → 整个界面位移、浮层看起来"飘走"。浮层内聚焦一律不触发滚动。
  const opts: FocusOptions = { preventScroll: true };
  if (dir === "first") {
    items[0].focus(opts);
    return;
  }
  if (dir === "last") {
    items[items.length - 1].focus(opts);
    return;
  }
  const cur = items.indexOf(document.activeElement as HTMLElement);
  // 焦点不在集合内（-1）：dir=1 时 base=-1 → next=0（首项）；dir=-1 时 base=0 → next=-1 环绕到末项
  const base = cur === -1 ? (dir === 1 ? -1 : 0) : cur;
  items[(base + dir + items.length) % items.length].focus(opts);
}

export interface MenuKeyNavOptions {
  /** → 键回调（菜单栏渲染器用：展开子菜单并移入焦点）；缺省不拦截 */
  onArrowRight?: (item: HTMLElement) => void;
  /** ← 键回调（子菜单用：折叠回父项）；缺省不拦截 */
  onArrowLeft?: (item: HTMLElement) => void;
  /** Esc 回调（如「只关子菜单回父项」）；缺省不拦截——事件继续冒泡到 window 级
   *  监听器（menu.ts / main.ts 各自的既有 Escape 关闭接线），不在本模块重复接线。 */
  onEscape?: () => void;
  /** Tab 键：APG 规定 Tab 退出菜单且不激活任何项。两套渲染器都传「关闭整个菜单」。
   *  preventDefault 后焦点留在原地（关闭时的焦点归还由各渲染器的 hide 路径负责）。 */
  onTab?: () => void;
}

/** 给菜单容器接键盘导航（每个容器只可调用一次；重复调用会叠加监听器）。
 *  所有被处理的按键都 stopPropagation：菜单栏的 Esc 需要「先关子菜单」的级联语义，
 *  若冒泡到 window 级监听器会把整个下拉一并关掉。 */
export function wireMenuKeyNav(root: HTMLElement, opts: MenuKeyNavOptions = {}): void {
  root.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    const item = target?.closest?.(".ctx-menu-item") as HTMLElement | null;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        moveMenuFocus(root, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        moveMenuFocus(root, -1);
        break;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        moveMenuFocus(root, "first");
        break;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        moveMenuFocus(root, "last");
        break;
      case "Enter":
      case " ":
        // 复用既有 click 回调（单一动作入口，与 termUi::makeSpanButton 同一做法）
        if (item) {
          e.preventDefault();
          e.stopPropagation();
          item.click();
        }
        break;
      case "ArrowRight":
        if (opts.onArrowRight && item) {
          e.preventDefault();
          e.stopPropagation();
          opts.onArrowRight(item);
        }
        break;
      case "ArrowLeft":
        if (opts.onArrowLeft && item) {
          e.preventDefault();
          e.stopPropagation();
          opts.onArrowLeft(item);
        }
        break;
      case "Escape":
        if (opts.onEscape) {
          e.preventDefault();
          e.stopPropagation();
          opts.onEscape();
        }
        break;
      case "Tab":
        if (opts.onTab) {
          e.preventDefault();
          e.stopPropagation();
          opts.onTab();
        }
        break;
    }
  });
}
