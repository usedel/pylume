// 菜单栏域（TD-14 拆分，原 main.ts 的「菜单栏 + 级联子菜单」段）：
// 顶部下拉菜单 / flyout 子菜单的渲染与键盘导航机制。菜单项数据（getMenuItems）
// 由 main 注入——菜单是跨域动作的汇聚点，机制与数据分离后本模块不再依赖任何业务域。

import { lazyEl } from "./state";
import { codicon } from "./util";
import { onLocaleChange, t } from "./i18n";
import { moveMenuFocus, wireMenuKeyNav } from "./menuKeys"; // UI-30：与 menu.ts 共享同一套 APG 规则

export interface MenuEntry {
  label: string;
  shortcut?: string;
  /** 子菜单项副标题（如最近工作区的路径） */
  detail?: string;
  action?: () => void;
  /** 有值即渲染为带 ❯ 的父项，悬停/点击展开右侧子菜单（MB-04：子菜单内禁止再嵌套） */
  submenu?: () => MenuEntry[] | Promise<MenuEntry[]>;
  sep?: boolean;
  /** MB-08：以下字段对齐 menu.ts::MenuItem 的语义（下拉/子菜单渲染各自处理，不共享渲染函数——
   *  两套 DOM 结构与 CSS 按 #menu-dropdown / #menu-submenu 容器隔离，见计划 MB-08 关键约束） */
  /** codicon 图标名（不含 "codicon-" 前缀） */
  icon?: string;
  /** 左侧打勾（单选组，如引擎切换）——显式传入（含 false）即渲染为 menuitemradio */
  checked?: boolean;
  /** 置灰不可用 */
  disabled?: boolean;
  /** 置灰时 hover 显示原因（走 data-tip 自绘 tooltip） */
  disabledReason?: string;
  /** 破坏性操作（红字） */
  danger?: boolean;
}

// P2-6（2026-09-29 review）：顶层快照改惰性（铁律 1，测试环境可 import）
const menuDropdownEl = lazyEl("menu-dropdown");
const submenuEl = lazyEl("menu-submenu");
let activeMenuBtn: HTMLElement | null = null;
/** 当前展开子菜单的父项元素（用于 hover 态与定位） */
let activeSubmenuParent: HTMLElement | null = null;
/** hover 延时展开 / 延时关闭定时器 */
let submenuTimer: number | undefined;
/** UI-30：父项元素 → 子菜单解析器（键盘 → 键展开子菜单时取用；渲染时写入，随元素销毁自动回收） */
const submenuResolvers = new WeakMap<HTMLElement, () => MenuEntry[] | Promise<MenuEntry[]>>();

function showMenuDropdown(btn: HTMLElement, getItems: (menu: string) => MenuEntry[], menu: string): void {
  const items = getItems(menu);
  menuDropdownEl.textContent = "";
  for (const it of items) {
    const el = document.createElement("div");
    if (it.sep) {
      el.className = "ctx-menu-item sep-item";
      el.setAttribute("role", "separator"); // UI-30
      const line = document.createElement("div");
      line.className = "sep";
      el.appendChild(line);
    } else if (it.submenu) {
      // 有子菜单的父项：右侧 ❯，悬停延时展开、点击切换。MB-08：禁用时置灰且不再接线展开
      el.className = "ctx-menu-item with-submenu";
      if (it.disabled) el.classList.add("disabled");
      if (it.danger) el.classList.add("danger");
      // UI-30：APG menu 模式——父项声明 haspopup，aria-expanded 由 openSubmenu/hideSubmenu 同源切换
      el.setAttribute("role", "menuitem");
      el.setAttribute("aria-haspopup", "menu");
      el.setAttribute("aria-expanded", "false");
      if (it.disabled) el.setAttribute("aria-disabled", "true"); // MB-08
      el.tabIndex = -1;
      // MB-08：前导槽——勾选优先于图标（与 menu.ts::renderItem 同语义，DOM 类名沿用本模块）
      if (it.checked) {
        const ic = document.createElement("span");
        ic.className = "mi-icon";
        ic.appendChild(codicon("check"));
        el.appendChild(ic);
      } else if (it.icon) {
        const ic = document.createElement("span");
        ic.className = "mi-icon";
        ic.appendChild(codicon(it.icon));
        el.appendChild(ic);
      }
      const labelSpan = document.createElement("span");
      labelSpan.textContent = it.label;
      el.appendChild(labelSpan);
      const arrow = document.createElement("span");
      arrow.className = "sub-arrow";
      arrow.textContent = "❯";
      el.appendChild(arrow);
      if (it.disabled) {
        // MB-08：禁用父项——不接线展开，点击不冒泡到 document 关闭监听（保持可见 + reason tooltip）
        if (it.disabledReason) el.dataset.tip = it.disabledReason;
        el.addEventListener("click", (e) => e.stopPropagation());
      } else {
        submenuResolvers.set(el, it.submenu); // UI-30：供键盘 → 键展开时取用
        el.addEventListener("mouseenter", () => scheduleSubmenu(el, it.submenu!));
        el.addEventListener("mouseleave", scheduleSubmenuClose);
        el.addEventListener("click", () => {
          if (activeSubmenuParent === el) hideSubmenu();
          else void openSubmenu(el, it.submenu!);
        });
      }
    } else {
      el.className = "ctx-menu-item";
      if (it.disabled) el.classList.add("disabled"); // MB-08
      if (it.danger) el.classList.add("danger"); // MB-08
      // MB-08：checked 显式传入（含 false）即视为单选组成员（与 menu.ts 同语义）
      if (it.checked !== undefined) {
        el.setAttribute("role", "menuitemradio");
        el.setAttribute("aria-checked", String(!!it.checked));
      } else {
        el.setAttribute("role", "menuitem"); // UI-30
      }
      if (it.disabled) el.setAttribute("aria-disabled", "true"); // MB-08
      el.tabIndex = -1;
      // MB-08：前导槽——勾选优先于图标
      if (it.checked) {
        const ic = document.createElement("span");
        ic.className = "mi-icon";
        ic.appendChild(codicon("check"));
        el.appendChild(ic);
      } else if (it.icon) {
        const ic = document.createElement("span");
        ic.className = "mi-icon";
        ic.appendChild(codicon(it.icon));
        el.appendChild(ic);
      }
      const labelSpan = document.createElement("span");
      labelSpan.textContent = it.label;
      el.appendChild(labelSpan);
      if (it.shortcut) {
        const sc = document.createElement("span");
        sc.className = "menu-shortcut";
        sc.textContent = it.shortcut;
        el.appendChild(sc);
      }
      el.addEventListener("mouseenter", () => {
        // MB-01：普通项也走延时关闭（与父项 mouseleave 同一 250ms 缓冲）——从父项斜向移向子菜单时，
        // 路径扫过的普通项只重置关闭计时（顺带取消悬停父项时留下的 200ms 待展开计时）；
        // 只要计时内落入子菜单容器（其 mouseenter 会取消计时），关闭即被取消。
        // 旧实现的立即关闭会让斜移路径上的任何普通项瞬间掐掉子菜单（原生菜单均有此缓冲）。
        scheduleSubmenuClose();
      });
      if (it.disabled) {
        // MB-08：禁用项不执行 action、不关闭菜单（点了没反应保持可见；tooltip 展示原因）
        if (it.disabledReason) el.dataset.tip = it.disabledReason;
        el.addEventListener("click", (e) => e.stopPropagation());
      } else {
        el.addEventListener("click", () => {
          hideMenuDropdown();
          it.action?.();
        });
      }
    }
    menuDropdownEl.appendChild(el);
  }
  menuDropdownEl.classList.remove("hidden");
  const rect = btn.getBoundingClientRect();
  menuDropdownEl.style.left = `${rect.left}px`;
  menuDropdownEl.style.top = `${rect.bottom + 2}px`;
  activeMenuBtn?.classList.remove("active");
  activeMenuBtn?.setAttribute("aria-expanded", "false"); // UI-30：直接切换菜单时旧按钮的开合态复位
  activeMenuBtn = btn;
  btn.classList.add("active");
  btn.setAttribute("aria-expanded", "true"); // UI-30
  // UI-30：打开即把焦点移入菜单首项（APG menu 模式），↑↓/Home/End/Enter 从此可用
  moveMenuFocus(menuDropdownEl, "first");
}

function hideMenuDropdown(): void {
  hideSubmenu();
  menuDropdownEl.classList.add("hidden");
  activeMenuBtn?.classList.remove("active");
  activeMenuBtn?.setAttribute("aria-expanded", "false"); // UI-30
  // UI-30：焦点尚未离开（仍在菜单内或掉到 body——如 Esc 关闭）时归还菜单按钮；
  // 用户已点击别处（含另一个菜单按钮）时焦点在点击目标上，不抢回
  const ae = document.activeElement;
  if (
    activeMenuBtn?.isConnected &&
    (ae === null || ae === document.body || menuDropdownEl.contains(ae) || submenuEl.contains(ae))
  ) {
    activeMenuBtn.focus();
  }
  activeMenuBtn = null;
}

// ---------- 级联子菜单（flyout） ----------

function cancelSubmenuTimer(): void {
  window.clearTimeout(submenuTimer);
  submenuTimer = undefined;
}

function hideSubmenu(): void {
  cancelSubmenuTimer();
  activeSubmenuParent?.classList.remove("open");
  activeSubmenuParent?.setAttribute("aria-expanded", "false"); // UI-30：与 .open 类同源切换
  activeSubmenuParent = null;
  submenuEl.classList.add("hidden");
  submenuEl.textContent = "";
}

/** 悬停父项：延时展开（连续移动会重置计时，避免闪烁） */
function scheduleSubmenu(parentEl: HTMLElement, resolve: () => MenuEntry[] | Promise<MenuEntry[]>): void {
  cancelSubmenuTimer();
  submenuTimer = window.setTimeout(() => { void openSubmenu(parentEl, resolve); }, 200);
}

/** 离开父项：延时关闭，给鼠标移入子菜单留缓冲 */
function scheduleSubmenuClose(): void {
  cancelSubmenuTimer();
  submenuTimer = window.setTimeout(hideSubmenu, 250);
}

/** @param focusFirst UI-30：键盘（→ 键）展开时把焦点移入子菜单首项；鼠标悬停/点击展开不抢焦点 */
async function openSubmenu(
  parentEl: HTMLElement,
  resolve: () => MenuEntry[] | Promise<MenuEntry[]>,
  focusFirst = false,
): Promise<void> {
  cancelSubmenuTimer();
  activeSubmenuParent?.classList.remove("open");
  activeSubmenuParent?.setAttribute("aria-expanded", "false"); // UI-30：切换父项时旧父项复位
  activeSubmenuParent = parentEl;
  parentEl.classList.add("open");
  parentEl.setAttribute("aria-expanded", "true"); // UI-30：与 .open 类同源切换

  let children: MenuEntry[];
  try {
    children = await resolve();
  } catch (e) {
    console.warn("读取子菜单失败", e);
    children = [{ label: t("ide.menuLoadFailed") }];
  }

  // 异步期间可能已切到其它父项或菜单已关闭
  if (activeSubmenuParent !== parentEl || menuDropdownEl.classList.contains("hidden")) return;

  submenuEl.textContent = "";
  for (const raw of children) {
    // MB-04：降级拦截——#menu-submenu 是单例容器，不支持嵌套展开。带 submenu 的子项在此
    // 显式 warn 并按普通项渲染（截断其 submenu 字段），不再静默丢弃展开语义（2026-09-21 裁决）。
    // 数据层约定：子菜单内禁止再放 submenu；若未来需要「工具 → 分类 → 子分类」，须先重构
    // submenuEl 为多实例栈（见 menubar_improvement_plan.md MB-04）。
    let it = raw;
    if (raw.submenu) {
      console.warn("[menuBar] 子菜单项不支持嵌套 submenu（单例容器），已按普通项渲染：", raw.label);
      it = { ...raw, submenu: undefined };
    }
    if (it.sep) {
      const el = document.createElement("div");
      el.className = "ctx-menu-item sep-item";
      el.setAttribute("role", "separator"); // UI-30
      const line = document.createElement("div");
      line.className = "sep";
      el.appendChild(line);
      submenuEl.appendChild(el);
    } else {
      const el = document.createElement("div");
      el.className = "ctx-menu-item";
      if (it.disabled) el.classList.add("disabled"); // MB-08
      if (it.danger) el.classList.add("danger"); // MB-08
      // MB-08：checked 显式传入（含 false）即视为单选组成员（与 menu.ts 同语义）
      if (it.checked !== undefined) {
        el.setAttribute("role", "menuitemradio");
        el.setAttribute("aria-checked", String(!!it.checked));
      } else {
        el.setAttribute("role", "menuitem"); // UI-30
      }
      if (it.disabled) el.setAttribute("aria-disabled", "true"); // MB-08
      el.tabIndex = -1;
      // MB-08：前导槽——勾选优先于图标（子菜单是 block 两行布局，前导槽仍在 label 前）
      if (it.checked) {
        const ic = document.createElement("span");
        ic.className = "mi-icon";
        ic.appendChild(codicon("check"));
        el.appendChild(ic);
      } else if (it.icon) {
        const ic = document.createElement("span");
        ic.className = "mi-icon";
        ic.appendChild(codicon(it.icon));
        el.appendChild(ic);
      }
      const labelSpan = document.createElement("span");
      labelSpan.className = "sub-label";
      labelSpan.textContent = it.label;
      el.appendChild(labelSpan);
      if (it.detail) {
        const detailSpan = document.createElement("span");
        detailSpan.className = "sub-detail";
        detailSpan.textContent = it.detail;
        detailSpan.title = it.detail;
        el.appendChild(detailSpan);
      }
      if (it.disabled) {
        // MB-08：禁用项不执行 action、不关闭菜单（tooltip 展示原因）
        if (it.disabledReason) el.dataset.tip = it.disabledReason;
        el.addEventListener("click", (e) => e.stopPropagation());
      } else {
        el.addEventListener("click", () => {
          hideMenuDropdown();
          it.action?.();
        });
      }
      submenuEl.appendChild(el);
    }
  }
  submenuEl.classList.remove("hidden");
  positionSubmenu(parentEl);
  if (focusFirst) moveMenuFocus(submenuEl, "first"); // UI-30
}

function positionSubmenu(parentEl: HTMLElement): void {
  const parentRect = parentEl.getBoundingClientRect();
  const menuRect = menuDropdownEl.getBoundingClientRect();
  // 先复位到 0 以便测量真实宽高
  submenuEl.style.left = "0px";
  submenuEl.style.top = "0px";
  const subRect = submenuEl.getBoundingClientRect();

  let left = menuRect.right - 1; // 紧贴父菜单右缘（共享 1px 边框）
  let top = parentRect.top;

  // 右侧放不下 → 折返到父菜单左侧
  if (left + subRect.width > window.innerWidth - 4) {
    left = menuRect.left - subRect.width + 1;
  }
  // 下缘溢出 → 向上夹取，保证不超视口
  if (top + subRect.height > window.innerHeight - 4) {
    top = window.innerHeight - subRect.height - 4;
  }
  if (top < 4) top = 4;

  submenuEl.style.left = `${left}px`;
  submenuEl.style.top = `${top}px`;
}

/** MB-05：菜单按钮集合（wireMenuBar 时快照一次——按钮是静态的，8 个顶级菜单不动态增减） */
let menubarBtns: HTMLElement[] = [];

/** MB-05：←/→ 环绕移动焦点到相邻菜单按钮；有菜单展开时同步切换下拉。
 *  Home/End 跳首尾。焦点不在按钮上时（如从下拉内收回）以当前 activeMenuBtn 为基准。 */
function moveMenubarFocus(dir: 1 | -1 | "first" | "last"): void {
  if (menubarBtns.length === 0) return;
  let idx: number;
  if (dir === "first") idx = 0;
  else if (dir === "last") idx = menubarBtns.length - 1;
  else {
    const cur = menubarBtns.indexOf(document.activeElement as HTMLElement);
    // 焦点在别处（如下拉项上）：以展开菜单的按钮为基准继续移动
    const base = cur === -1 ? menubarBtns.indexOf(activeMenuBtn as HTMLElement) : cur;
    idx = (base + dir + menubarBtns.length) % menubarBtns.length;
  }
  const btn = menubarBtns[idx];
  if (activeMenuBtn && activeMenuBtn !== btn) {
    // 展开态下移动 = 切换菜单（与 MB-02 hover 切换同路径）；焦点由 showMenuDropdown 移入下拉首项
    showMenuDropdownFromBtn(btn);
  } else {
    btn.focus();
  }
}

/** MB-05/MB-02 共用：切换到目标菜单按钮（内部经 showMenuDropdown，含 aria 同源切换） */
function showMenuDropdownFromBtn(btn: HTMLElement): void {
  if (activeMenuBtn === btn) return;
  hideMenuDropdown();
  showMenuDropdown(btn, currentGetItems, btn.dataset.menu ?? "");
}

/** wireMenuBar 捕获的数据源（showMenuDropdownFromBtn 切换时取用） */
let currentGetItems: (menu: string) => MenuEntry[] = () => [];

/** 菜单栏接线（main 的 init 调用）；getItems = main 的 getMenuItems（跨域动作数据源） */
export function wireMenuBar(getItems: (menu: string) => MenuEntry[]): void {
  currentGetItems = getItems;
  menubarBtns = Array.from(document.querySelectorAll<HTMLElement>(".menubar-item"));
  menubarBtns.forEach((btn) => {
    // MB-02：已有菜单展开时，鼠标滑到相邻菜单按钮即切换（原生菜单栏惯例）；
    // 未展开时悬停不弹菜单（避免平时移动鼠标乱弹）。切换路径复用 click 的既有逻辑，
    // 焦点由 showMenuDropdown 移入新下拉首项，Esc 关闭时归还新按钮（activeMenuBtn 已同源更新）。
    btn.addEventListener("mouseenter", () => {
      if (activeMenuBtn === null || activeMenuBtn === btn) return;
      showMenuDropdownFromBtn(btn);
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeMenuBtn === btn) {
        hideMenuDropdown();
      } else {
        showMenuDropdownFromBtn(btn);
      }
    });
  });
  // i18n：菜单项文案由 main 的 getMenuItems 经 t() 现算（数据不是常量表），切换语言后
  // 展开中的下拉必须就地重绘，否则用户看到「外壳已切英文、菜单仍是中文」的半切换态。
  // 这里刻意直接调 showMenuDropdown 而非 showMenuDropdownFromBtn——后者遇 activeMenuBtn === btn
  // 会判为「点同一个按钮 = 关闭」，重绘会变成收起；先收子菜单避免残留旧语言的 flyout。
  onLocaleChange(() => {
    const btn = activeMenuBtn;
    if (!btn) return;
    hideSubmenu();
    showMenuDropdown(btn, currentGetItems, btn.dataset.menu ?? "");
  });
  // MB-05：menubar 本体键盘漫游（APG menubar 模式）。←/→ 环绕、Home/End 首尾；
  // 焦点在下拉/子菜单内时不经过这里（那些容器有自己的 wireMenuKeyNav）。
  document.getElementById("menubar")?.addEventListener("keydown", (e) => {
    if (!(e.target instanceof HTMLElement) || !e.target.closest(".menubar-item")) return;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveMenubarFocus(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveMenubarFocus(1);
        break;
      case "Home":
        e.preventDefault();
        moveMenubarFocus("first");
        break;
      case "End":
        e.preventDefault();
        moveMenubarFocus("last");
        break;
    }
  });
  menuDropdownEl.addEventListener("click", (e) => e.stopPropagation());
  submenuEl.addEventListener("click", (e) => e.stopPropagation());
  submenuEl.addEventListener("mouseenter", cancelSubmenuTimer);
  submenuEl.addEventListener("mouseleave", scheduleSubmenuClose);
  document.addEventListener("click", () => {
    if (!menuDropdownEl.classList.contains("hidden")) hideMenuDropdown();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menuDropdownEl.classList.contains("hidden")) hideMenuDropdown();
  });
  // MB-06：窗口 resize 兜底——下拉/子菜单是 position:fixed 浮层，定位只在展开时算一次；
  // 窗口尺寸变化后优先重定位（下拉贴按钮左缘 + 子菜单贴父项），重定位后仍放不下则收起。
  window.addEventListener("resize", () => {
    if (menuDropdownEl.classList.contains("hidden")) return;
    if (activeMenuBtn) {
      const rect = activeMenuBtn.getBoundingClientRect();
      // 下拉宽度超出视口（如窗口拖得极窄）→ 收起，不强行塞
      if (menuDropdownEl.getBoundingClientRect().width > window.innerWidth - 8) {
        hideMenuDropdown();
        return;
      }
      menuDropdownEl.style.left = `${rect.left}px`;
      menuDropdownEl.style.top = `${rect.bottom + 2}px`;
      if (activeSubmenuParent && !submenuEl.classList.contains("hidden")) positionSubmenu(activeSubmenuParent);
    } else {
      hideMenuDropdown();
    }
  });
  // UI-30：下拉菜单的键盘导航（↑↓/Home/End 漫游、Enter/Space 激活、Tab 退出，见 menuKeys.ts）。
  // Esc 走级联语义：子菜单开着先关子菜单、焦点回父项；否则关整个下拉（焦点归还菜单按钮）。
  // 两者都 stopPropagation，不再触发上面 window 级 Escape 的整体关闭。
  wireMenuKeyNav(menuDropdownEl, {
    onArrowRight: (item) => {
      if (!item.classList.contains("with-submenu")) return;
      const resolve = submenuResolvers.get(item);
      if (resolve) void openSubmenu(item, resolve, true); // 键盘展开 → 焦点移入子菜单
    },
    // MB-05：下拉内按 ← 切到上一个顶级菜单（与 → 展开子菜单 / menubar 漫游衔接成环）
    onArrowLeft: () => {
      if (activeSubmenuParent) {
        // 子菜单开着先收回（与 Esc 同语义），再切上一个菜单
        hideSubmenu();
      }
      moveMenubarFocus(-1);
    },
    onEscape: () => {
      if (activeSubmenuParent) {
        const p = activeSubmenuParent;
        hideSubmenu();
        p.focus();
      } else {
        hideMenuDropdown();
      }
    },
    onTab: () => hideMenuDropdown(),
  });
  // 子菜单：← / Esc 折叠回父项（APG 级联菜单的退出方向）；Tab 关整个下拉
  wireMenuKeyNav(submenuEl, {
    onArrowLeft: () => {
      const p = activeSubmenuParent;
      hideSubmenu();
      p?.focus();
    },
    onEscape: () => {
      const p = activeSubmenuParent;
      hideSubmenu();
      p?.focus();
    },
    onTab: () => hideMenuDropdown(),
  });
}
