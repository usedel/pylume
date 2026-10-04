// 面板布局域（D2 P-03）：侧栏宽度 / 底部面板高度拖拽调整 + 本地持久化。
// 尺寸存 localStorage 而非全局 Settings：布局属视图状态（类 VS Code workspace state），
// 避免为 UI 尺寸改动 Rust Settings 结构与前后端漂移锁。

import { $ } from "./state";

const SIDEBAR_KEY = "pylume.sidebar_width";
const BOTTOM_KEY = "pylume.bottom_height";
const RIGHT_KEY = "pylume.rightpanel_width";
const OUTLINE_KEY = "pylume.outline_height";
const MD_PREVIEW_KEY = "pylume.mdpreview_width";
/** C-4：分屏面板宽度记忆（键名风格与其余面板键一致；splitEditor.ts 恢复时读同一键） */
const SPLIT_W_KEY = "pylume-split-w";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEF = 280;
const BOTTOM_MIN = 120;
/** 无 BOTTOM_DEF：默认高（220px）在 style.css 的 `#bottom { height: var(--bottom-h, 220px) }`，
 *  双击重置 = 清除 --bottom-h 回落 CSS 默认（与 OUTLINE 的处理一致，真值只有一份）。 */
const RIGHT_MIN = 260;
const RIGHT_MAX = 560;
const RIGHT_DEF = 360;
/** 底部面板最大高度占视口比例 */
const BOTTOM_MAX_RATIO = 0.6;
/** UI-22：大纲区最小高度（px）——够放 header + 一两行符号 */
const OUTLINE_MIN = 60;
/** UI-22：大纲区最大高度占文件视图比例——保证文件树至少留 40%。
 *  无 OUTLINE_DEF：默认是 CSS 的「内容高 + max-height:40%」，双击清除内联 --outline-h/--outline-max 即回落（"重置为默认比例"）。 */
const OUTLINE_MAX_RATIO = 0.6;
/** Markdown 预览分栏最小宽度（markdown preview dev plan §5-T2）；上限 = editor-row 宽 − 编辑器最小宽（拖拽时动态收口） */
const MD_PREVIEW_MIN = 200;
/** 预览宽度上限占视口比例（恢复历史宽度时的兜底，类似 OUTLINE_MAX_RATIO） */
const MD_PREVIEW_MAX_RATIO = 0.6;

/** UI-23：编辑区（#center）的最小可用宽度。真值在 style.css 的 `#center { min-width: 240px }`，
 *  这里在拖拽开始时读一次计算样式（不在 mousemove 里读，避免每帧触发样式重算）；
 *  读不到（如无样式表的环境）时回落此常量——常量与 CSS 若漂移，退化结果只是上限略偏，不会溢出。 */
const CENTER_MIN_FALLBACK = 240;

function centerMin(): number {
  const raw = parseFloat(getComputedStyle($("center")).minWidth);
  return Number.isFinite(raw) && raw > 0 ? raw : CENTER_MIN_FALLBACK;
}

/** UI-23：侧栏 / 右侧面板的拖拽上限动态收口。
 *  两个面板现在是 `flex: 0 1 auto` + min-width（可收缩，给 #center 的硬下限让位），
 *  写进 style 的宽度在窄窗口下会被 flex 收缩吃掉；若拖拽仍按 SIDEBAR_MAX / RIGHT_MAX 这类
 *  「窗口够宽时才成立」的常量夹取，就会出现「鼠标在动、分隔条不跟」的粘滞手感。
 *  故上限 = min(硬上限, 窗口宽 − 编辑区下限 − 对面面板当前实际宽)，且不低于本面板自身下限。
 *  对面面板收起时（display:none）rect 宽为 0，上限自然退回硬上限。 */
function dragMax(hardMax: number, selfMin: number, opposite: HTMLElement): number {
  const avail = window.innerWidth - centerMin() - opposite.getBoundingClientRect().width;
  return Math.max(selfMin, Math.min(hardMax, Math.floor(avail)));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function readStored(key: string): number | null {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** P1（UX 审查）：切换侧栏显隐（键位 Ctrl+Shift+F12 / 视图菜单共用唯一实现）。
 *  宽度仍由 --sidebar-w / 内联 width 持久化，隐藏只是 display:none，重新展开不丢尺寸。 */
export function toggleSidebar(): void {
  document.getElementById("sidebar")?.classList.toggle("hidden");
}

/** 启动时恢复上次的侧栏宽度 / 底部面板高度 / 右侧面板宽度 / 大纲高度（越界值忽略） */
export function restoreLayout(): void {
  const sw = readStored(SIDEBAR_KEY);
  if (sw !== null && sw >= SIDEBAR_MIN && sw <= SIDEBAR_MAX) {
    $("sidebar").style.width = `${sw}px`;
  }
  // 遗留修复（第八批登记）：底部面板高度写自定义属性 --bottom-h 而非内联 height——
  // 内联样式特异性最高，会压过样式表的 #bottom.collapsed{height:28px}，
  // 拖过（或恢复过）高度之后就再也收不起来（与 #outline-section 的 --outline-h 同一方案，UI-22 决策 2）。
  const bh = readStored(BOTTOM_KEY);
  if (bh !== null && bh >= BOTTOM_MIN) {
    $("bottom").style.setProperty("--bottom-h", `${Math.min(bh, Math.floor(window.innerHeight * BOTTOM_MAX_RATIO))}px`);
  }
  const rw = readStored(RIGHT_KEY);
  if (rw !== null && rw >= RIGHT_MIN && rw <= RIGHT_MAX) {
    $("right-panel").style.width = `${rw}px`;
  }
  // UI-22：大纲区高度写自定义属性 --outline-h（非内联 height，见 style.css #outline-section 注释）。
  // 上限用 window.innerHeight 兜底（此时视图未必已布局）；拖拽时再按 view-files 实际高精确 clamp。
  const oh = readStored(OUTLINE_KEY);
  if (oh !== null && oh >= OUTLINE_MIN) {
    const capped = Math.min(oh, Math.floor(window.innerHeight * OUTLINE_MAX_RATIO));
    const outline = $("outline-section");
    outline.style.setProperty("--outline-h", `${capped}px`);
    outline.style.setProperty("--outline-max", "none"); // 与拖拽一致：定高时解除 40% 封顶
  }
  // Markdown 预览分栏宽度恢复（key 对齐 SIDEBAR_KEY 先例；上限按视口比例兜底，拖拽时再精确 clamp）
  const mpw = readStored(MD_PREVIEW_KEY);
  if (mpw !== null && mpw >= MD_PREVIEW_MIN) {
    const capped = Math.min(mpw, Math.floor(window.innerWidth * MD_PREVIEW_MAX_RATIO));
    $("md-preview").style.setProperty("--mdpreview-w", `${capped}px`);
  }
}

/** 通用拖：拖动期间给热区加 .dragging（样式反馈），结束时回调 onDone */
function startDrag(handle: HTMLElement, onMove: (e: MouseEvent) => void, onDone?: () => void): void {
  handle.classList.add("dragging");
  const move = (e: MouseEvent): void => {
    e.preventDefault();
    onMove(e);
  };
  const up = (): void => {
    handle.classList.remove("dragging");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    onDone?.();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/** 接线各分隔条（侧栏 / 右侧面板 / 底部面板 / 大纲）：拖拽调整 + 双击重置 */
export function wireSplitters(): void {
  const sidebar = $("sidebar");
  const bottom = $("bottom");
  // UI-23：拖拽上限要按「对面面板当前实际宽」收口，故两个面板元素都在接线前取好
  const rightPanel = $("right-panel");

  const sidebarSplitter = $("sidebar-splitter");
  sidebarSplitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const left = sidebar.getBoundingClientRect().left;
    const max = dragMax(SIDEBAR_MAX, SIDEBAR_MIN, rightPanel); // UI-23：按下时算一次，拖拽中不重复读样式
    sidebar.classList.add("resizing"); // D3：拖拽期间关闭宽度过渡，避免跟手延迟
    startDrag(
      sidebarSplitter,
      (ev) => {
        const w = clamp(Math.round(ev.clientX - left), SIDEBAR_MIN, max);
        sidebar.style.width = `${w}px`;
        localStorage.setItem(SIDEBAR_KEY, String(w));
      },
      () => sidebar.classList.remove("resizing"),
    );
  });
  sidebarSplitter.addEventListener("dblclick", () => {
    sidebar.style.width = `${SIDEBAR_DEF}px`;
    localStorage.removeItem(SIDEBAR_KEY);
  });

  const rightSplitter = $("right-splitter");
  rightSplitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const right = rightPanel.getBoundingClientRect().right;
    const max = dragMax(RIGHT_MAX, RIGHT_MIN, sidebar); // UI-23：对面是侧栏
    rightPanel.classList.add("resizing");
    startDrag(
      rightSplitter,
      (ev) => {
        const w = clamp(Math.round(right - ev.clientX), RIGHT_MIN, max);
        rightPanel.style.width = `${w}px`;
        localStorage.setItem(RIGHT_KEY, String(w));
      },
      () => rightPanel.classList.remove("resizing"),
    );
  });
  rightSplitter.addEventListener("dblclick", () => {
    rightPanel.style.width = `${RIGHT_DEF}px`;
    localStorage.removeItem(RIGHT_KEY);
  });

  const bottomSplitter = $("bottom-splitter");
  bottomSplitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    bottom.classList.remove("collapsed"); // 收起态拖动 = 直接展开调整
    bottom.classList.add("resizing"); // D3：拖拽期间关闭高度过渡，避免跟手延迟
    startDrag(
      bottomSplitter,
      (ev) => {
        const max = Math.floor(window.innerHeight * BOTTOM_MAX_RATIO);
        const h = clamp(Math.round(window.innerHeight - ev.clientY), BOTTOM_MIN, max);
        bottom.style.setProperty("--bottom-h", `${h}px`); // 遗留修复：不写内联 height，.collapsed 才能覆盖
        localStorage.setItem(BOTTOM_KEY, String(h));
      },
      () => bottom.classList.remove("resizing"),
    );
  });
  bottomSplitter.addEventListener("dblclick", () => {
    // 清除定高 → 回落 CSS 默认 `var(--bottom-h, 220px)`（"重置为默认高度"，与大纲双击同一语义）
    bottom.style.removeProperty("--bottom-h");
    localStorage.removeItem(BOTTOM_KEY);
  });

  // UI-22：文件树 / 大纲之间的高度拖拽（复用 startDrag + localStorage 持久化）
  const outlineSection = $("outline-section");
  const viewFiles = $("view-files");
  const outlineSplitter = $("outline-splitter");
  outlineSplitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    outlineSection.classList.remove("collapsed"); // 收起态拖动 = 直接展开调整（同底部面板）
    // outline-section 是 #view-files 最后一个子元素，底边锚定在视图底部、不随高度变化；
    // 故拖拽中「高度 = 固定底边 − 鼠标 Y」，tree(flex:1) 自动吸收剩余空间。
    const bottom = outlineSection.getBoundingClientRect().bottom;
    startDrag(outlineSplitter, (ev) => {
      const max = Math.max(OUTLINE_MIN, Math.floor(viewFiles.clientHeight * OUTLINE_MAX_RATIO));
      const h = clamp(Math.round(bottom - ev.clientY), OUTLINE_MIN, max);
      outlineSection.style.setProperty("--outline-h", `${h}px`);
      outlineSection.style.setProperty("--outline-max", "none"); // 解除 40% 封顶，允许拖过默认比例
      localStorage.setItem(OUTLINE_KEY, String(h));
    });
  });
  outlineSplitter.addEventListener("dblclick", () => {
    // 清除定高与封顶覆盖 → 回落 CSS 默认「内容高 + 上限 40%」（"重置为默认比例"）
    outlineSection.style.removeProperty("--outline-h");
    outlineSection.style.removeProperty("--outline-max");
    localStorage.removeItem(OUTLINE_KEY);
  });

  // Markdown 预览分栏拖拽（markdown preview dev plan §5-T2）：复用 startDrag + localStorage。
  // 预览在右：宽度 = editor-row 右缘 − 鼠标 X；编辑器（flex:1）自动吸收剩余空间。
  const mdEditorRow = $("editor-row");
  const mdPreview = $("md-preview");
  const mdSplitter = $("md-splitter");
  mdSplitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rowRight = mdEditorRow.getBoundingClientRect().right;
    // 上限 = editor-row 宽 − 编辑器最小宽（centerMin 读 #center 的 min-width，与侧栏/右面板同源）
    const max = Math.max(MD_PREVIEW_MIN, Math.floor(mdEditorRow.clientWidth - centerMin()));
    mdPreview.classList.add("resizing");
    startDrag(
      mdSplitter,
      (ev) => {
        const w = clamp(Math.round(rowRight - ev.clientX), MD_PREVIEW_MIN, max);
        mdPreview.style.setProperty("--mdpreview-w", `${w}px`);
        localStorage.setItem(MD_PREVIEW_KEY, String(w));
      },
      () => mdPreview.classList.remove("resizing"),
    );
  });
  mdSplitter.addEventListener("dblclick", () => {
    mdPreview.style.removeProperty("--mdpreview-w");
    localStorage.removeItem(MD_PREVIEW_KEY);
  });

  // C-4：分屏面板拖拽（与 md 分栏同范式：右侧面板，宽度 = row 右缘 − 鼠标 X，
  // 编辑器 flex:1 自动吸收剩余空间；min 240 保证两侧都可用，上限随 editor-row 收口）。
  const splitPanel = $("split-editor-panel");
  const splitSplitter = $("split-splitter");
  splitSplitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rowRight = mdEditorRow.getBoundingClientRect().right;
    const max = Math.max(240, Math.floor(mdEditorRow.clientWidth - centerMin()));
    splitPanel.classList.add("resizing");
    startDrag(
      splitSplitter,
      (ev) => {
        const w = clamp(Math.round(rowRight - ev.clientX), 240, max);
        splitPanel.style.setProperty("--split-w", `${w}px`);
        localStorage.setItem(SPLIT_W_KEY, String(w));
      },
      () => splitPanel.classList.remove("resizing"),
    );
  });
  splitSplitter.addEventListener("dblclick", () => {
    splitPanel.style.removeProperty("--split-w");
    localStorage.removeItem(SPLIT_W_KEY);
  });
}

/** v1.4 Tab 化：宽屏态已退役（对象树列宽拖拽随 #db-wide-splitter 一并移除）。 */
