// 通用组合框（combobox）：输入框 + 即时下拉候选。
//
// 设计要点：
// - 复用 Quick Open 的 fuzzyScore 做模糊过滤，手感与全局搜索一致；
// - 下拉用 fixed 定位（JS 按输入框坐标实时计算），避开任意祖先 overflow 裁剪
//   （如运行配置面板的 .run-config-editor 有 overflow-y:auto，absolute 会被裁）；
// - 候选分两类：provide 返回的主体（参与过滤、可缓存）+ tail 返回的固定尾部项
//   （如「浏览…」，不参与过滤、恒在末尾、每次渲染重算）；
// - 交互：focus 展开（展示全部候选，便于在已有保存值时重选）/ input 防抖过滤 / ↑↓ 导航 /
//   Enter 选中 / Esc 收起（展开时 stopPropagation，避免误关外层模态）/ mousedown 选中
//   （preventDefault 抢在 blur 前）/ blur 与点击外部收起；
// - 可访问性：遵循 WAI-ARIA combobox 模式——input role=combobox + aria-expanded/controls/
//   activedescendant，drop role=listbox，item role=option + aria-selected/aria-disabled；
//   焦点始终留在 input，高亮项通过 aria-activedescendant 暴露；
// - 竞态：provide 异步，用 loadToken 防旧请求覆盖、refreshToken 防旧 refresh 渲染；
//   同一时刻只允许一个 in-flight provide（loading promise 复用）；refresh 渲染前校验
//   document.activeElement，杜绝「失焦后下拉幽灵重现」；invalidate 同时作废 in-flight 结果；
// - 性能：input 过滤防抖（DEBOUNCE_MS），大项目（数千文件）连续击键不全量重算。
//
// 本组件零业务依赖（只 import fuzzyScore），可被任意「输入即推荐」场景复用。

import { fuzzyScore } from "./quickOpen";
import { t } from "./i18n"; // 第十六批 i18n：组合框加载/空态走语言包

/** 一条下拉候选 */
export interface ComboboxItem {
  /** 选中后填入输入框的值；省略则用 label */
  value?: string;
  /** 主显示文本 */
  label: string;
  /** 次要文本（路径 / 版本等，右对齐小字） */
  detail?: string;
  /** 动作项：点击执行此动作而非填值（如「浏览…」打开系统对话框） */
  action?: () => void;
  /** 仅展示、不可选（如「未检测到解释器」提示） */
  disabled?: boolean;
}

export interface ComboboxOptions {
  /** 提供主体候选（异步；组件缓存结果，invalidate 后重拉） */
  provide: () => Promise<ComboboxItem[]>;
  /** 固定尾部项（每次渲染重算，如「浏览…」）；不参与过滤，恒在末尾 */
  tail?: () => ComboboxItem[];
  /** 无候选时的占位提示 */
  emptyText?: string;
  /** 主体候选过滤后的上限（默认 50） */
  maxItems?: number;
}

export interface Combobox {
  /** 作废候选缓存（工作区切换等），下次展开重拉 */
  invalidate(): void;
  /** 收起下拉 */
  close(): void;
  /** 启用/禁用（禁用时不展开，如模块入口不需要脚本补全） */
  setEnabled(enabled: boolean): void;
}

/** drop 缺 id 时的自增序号（aria-controls / option id 前缀用） */
let comboSeq = 0;
/** input 过滤防抖（ms）：大项目连续击键不全量重算 fuzzyScore */
const DEBOUNCE_MS = 80;

export function createCombobox(
  input: HTMLInputElement,
  drop: HTMLElement,
  opts: ComboboxOptions,
): Combobox {
  // ---------- ARIA 初始化（WAI-ARIA combobox 模式） ----------
  if (!drop.id) drop.id = `oc-combo-drop-${++comboSeq}`;
  const dropId = drop.id;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", dropId);
  input.setAttribute("aria-expanded", "false");
  drop.setAttribute("role", "listbox");

  // ---------- 状态 ----------
  let items: ComboboxItem[] | null = null; // null = 未加载
  let filtered: ComboboxItem[] = [];
  let tail: ComboboxItem[] = [];
  let sel = 0;
  let open = false;
  let enabled = true;
  let loadToken = 0;
  let refreshToken = 0;
  let loading: Promise<void> | null = null;
  let debounceTimer: number | null = null;

  const list = (): ComboboxItem[] => [...filtered, ...tail];

  /** fixed 定位：贴输入框下沿、同宽；下方空间不足则上翻 */
  function positionDrop(): void {
    const r = input.getBoundingClientRect();
    drop.style.left = `${r.left}px`;
    drop.style.width = `${r.width}px`;
    drop.style.top = `${r.bottom + 2}px`;
    const dh = drop.offsetHeight;
    if (r.bottom + 2 + dh > window.innerHeight - 8) {
      drop.style.top = `${Math.max(8, r.top - dh - 2)}px`;
    }
  }

  /** 仅切换高亮 class + ARIA（不重建 DOM），用于键盘/hover 导航 */
  function setActive(i: number): void {
    sel = i;
    const rows = drop.querySelectorAll<HTMLElement>(".oc-combo-item");
    rows.forEach((r, idx) => {
      r.classList.toggle("active", idx === i);
      r.setAttribute("aria-selected", String(idx === i));
    });
    rows[i]?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", `${dropId}-opt-${i}`);
  }

  async function load(): Promise<void> {
    if (items !== null) return;
    if (loading) return loading;
    const token = ++loadToken;
    loading = (async () => {
      drop.textContent = "";
      const ph = document.createElement("div");
      ph.className = "oc-combo-item disabled";
      ph.setAttribute("role", "option");
      ph.setAttribute("aria-disabled", "true");
      ph.textContent = t("common.loading");
      drop.appendChild(ph);
      drop.classList.add("open");
      input.setAttribute("aria-expanded", "true");
      input.removeAttribute("aria-activedescendant"); // 加载态无高亮项
      positionDrop();
      let loaded: ComboboxItem[];
      try {
        loaded = await opts.provide();
      } catch {
        loaded = [];
      }
      if (token === loadToken) items = loaded;
    })();
    try {
      await loading;
    } finally {
      loading = null;
    }
  }

  function doFilter(showAll = false): void {
    // showAll（聚焦时）忽略当前值、展示全部候选，便于在已有保存值时重新挑选
    const q = showAll ? "" : input.value.trim();
    const base = items ?? [];
    const max = opts.maxItems ?? 50;
    if (!q) {
      filtered = base.slice(0, max);
    } else {
      const scored: Array<{ it: ComboboxItem; score: number }> = [];
      for (const it of base) {
        const s1 = fuzzyScore(it.label, q);
        const s2 = it.detail ? fuzzyScore(it.detail, q) : null;
        const score = Math.max(s1 ?? -1, s2 ?? -1);
        if (score >= 0) scored.push({ it, score });
      }
      scored.sort((a, b) => b.score - a.score || a.it.label.length - b.it.label.length);
      filtered = scored.slice(0, max).map((x) => x.it);
    }
    // 主体无匹配时插入 disabled 提示项（不可选，但与 tail 同列，导航索引连续）
    if (filtered.length === 0 && opts.emptyText) {
      filtered = [{ label: opts.emptyText, disabled: true }];
    }
    tail = opts.tail ? opts.tail() : [];
  }

  function render(): void {
    drop.textContent = "";
    const all = list();
    if (all.length === 0) {
      const empty = document.createElement("div");
      empty.className = "oc-combo-item disabled";
      empty.setAttribute("role", "option");
      empty.setAttribute("aria-disabled", "true");
      empty.textContent = opts.emptyText ?? t("common.noMatch");
      drop.appendChild(empty);
      drop.classList.add("open");
      input.setAttribute("aria-expanded", "true");
      input.removeAttribute("aria-activedescendant");
      positionDrop();
      return;
    }
    all.forEach((it, i) => {
      const row = document.createElement("div");
      row.className =
        "oc-combo-item" +
        (i === sel ? " active" : "") +
        (it.disabled ? " disabled" : "") +
        (it.action ? " action" : "");
      row.id = `${dropId}-opt-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === sel));
      if (it.disabled) row.setAttribute("aria-disabled", "true");
      row.dataset.index = String(i);
      const label = document.createElement("span");
      label.className = "oci-label";
      label.textContent = it.label;
      row.appendChild(label);
      if (it.detail) {
        const detail = document.createElement("span");
        detail.className = "oci-detail";
        detail.textContent = it.detail;
        detail.title = it.detail;
        row.appendChild(detail);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 抢在 blur 前，保证点击选中生效
        if (it.disabled) return;
        selectIndex(i);
      });
      row.addEventListener("mouseenter", () => {
        if (sel !== i) setActive(i);
      });
      drop.appendChild(row);
    });
    drop.classList.add("open");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", `${dropId}-opt-${sel}`);
    positionDrop();
  }

  function selectIndex(i: number): void {
    const it = list()[i];
    if (!it || it.disabled) return;
    close();
    if (it.action) {
      it.action();
      return;
    }
    input.value = it.value ?? it.label;
  }

  async function refresh(showAll = false): Promise<void> {
    if (!enabled || input.disabled) {
      close();
      return;
    }
    const t = ++refreshToken;
    await load();
    if (t !== refreshToken) return; // 已有更新的 refresh，丢弃本次渲染
    if (!enabled || input.disabled) {
      close();
      return;
    }
    // provide 期间可能已失焦（用户点了别处）：不再展开，杜绝下拉「幽灵重现」
    if (document.activeElement !== input) {
      close();
      return;
    }
    doFilter(showAll);
    // 初始高亮第一个可选项（跳过无匹配提示等 disabled 项）
    const all = list();
    const firstEnabled = all.findIndex((it) => !it.disabled);
    sel = firstEnabled >= 0 ? firstEnabled : 0;
    render();
    open = true;
  }

  function close(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    drop.classList.remove("open");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    open = false;
  }

  // ---------- 事件接线 ----------
  input.addEventListener("focus", () => {
    input.select(); // 选中当前值，便于直接输入替换
    void refresh(true); // 聚焦展示全部候选（不被当前值过滤）
  });
  input.addEventListener("input", () => {
    // 防抖：连续击键只在停顿后过滤一次（大项目数千候选不全量重算）
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void refresh(false);
    }, DEBOUNCE_MS);
  });
  input.addEventListener("blur", () => {
    close(); // close 内清防抖 timer，避免失焦后延迟 refresh 重新展开
  });
  input.addEventListener("keydown", (e) => {
    if (!open) {
      // 未展开：↑↓ 可展开（立即，不防抖）；其余键（含 Esc）正常冒泡（Esc 交给外层模态关闭）
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        void refresh(true);
      }
      return;
    }
    const all = list();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        if (all.length) setActive((sel + 1) % all.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        if (all.length) setActive((sel - 1 + all.length) % all.length);
        break;
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        if (all.length) selectIndex(sel);
        break;
      case "Escape":
        // 收起下拉，并阻止冒泡到外层模态的 Esc 关闭（第一次 Esc 收下拉，第二次才关面板）
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close(); // Tab 移走焦点即收起
        break;
    }
  });

  const onDocMouseDown = (e: MouseEvent): void => {
    if (!open) return;
    const t = e.target as Node;
    if (drop.contains(t) || input.contains(t)) return;
    close();
  };
  document.addEventListener("mousedown", onDocMouseDown);

  // fixed 下拉不随祖先滚动容器移动：任意滚动（下拉自身除外）即收起，避免「漂移」错位
  const onScroll = (e: Event): void => {
    if (!open) return;
    if (drop.contains(e.target as Node)) return; // 下拉内部滚动不收起
    close();
  };
  document.addEventListener("scroll", onScroll, true);

  return {
    invalidate() {
      items = null;
      loading = null; // 丢弃进行中的旧请求引用，下次展开重新拉取
      loadToken++; // 作废旧请求结果（即便稍后完成也不写入 items）
    },
    close,
    setEnabled(v: boolean) {
      enabled = v;
      if (!v) close();
    },
  };
}
