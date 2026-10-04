// 自绘 Tooltip（D3 P-11）：300ms 延迟 + 深色浮层 + 可选快捷键副文本，样式统一。
// 用法：目标元素加 data-tip="提示文本"，可选 data-tip-key="Ctrl+S"；
// wireTooltip() 于 init 调用一次（document 级事件委托，无需逐元素绑定）。
//
// ---------- UI-09：data-tip 与原生 title 的分工规则 ----------
// 迁移前全库两套并存、风格与延迟都不一致。现按下列规则单一归口，判定顺序自上而下：
//
// 1) 【用 data-tip】一切「不会被禁用」的交互控件（图标按钮、工具栏按钮、可点击行/热区）。
//    图标按钮必须同时补 aria-label：内部 <i> 由 codicon() 统一带 aria-hidden，
//    可访问名称此前完全靠 title 提供，只删 title 不补 aria-label 会让读屏读到「未命名按钮」。
// 2) 【保留原生 title】带 disabled 属性（含动态禁用）的控件。
//    原因：Chromium 不向禁用的表单控件派发鼠标事件（事件落到父元素），data-tip 会静默失效；
//    而原生 title 由渲染层命中测试驱动，禁用态仍显示。禁用原因恰是最需要提示的信息，不能赌。
//    已登记例外：#git-commit-btn、#env-pkg-upgrade-all/-uninstall-selected、#lt-group-rename/
//    -batch-enable/-batch-disable、jsonpath 复制路径/值、模板编辑器 delBtn/resetBtn。
//    例外中的例外：调试工具栏 6 按钮本是图标按钮且未调试时全禁用，已改用 .is-disabled +
//    aria-disabled 取代 disabled 属性（见 debugView.ts::toolbarButton），从而可用 data-tip，
//    并顺带让按钮保留在 tab 序列内、读屏能听到「已禁用」。
// 3) 【保留原生 title】表单控件 <select>/<input>：已有可见 label，自绘浮层反而会盖住下拉区域。
// 4) 【保留原生 title】纯截断披露场景（路径、长文件名、`名称:行号`、变量值、提交详情）：
//    原生 title 语义恰当且无需统一视觉，如 .tree-item / .scm-name / .outline-item / .env-item
//    （.env-item 已随解释器列表退役，此例仅作规则示意）。
// 5) 【嵌套约束】原生 title 会沿祖先链继承解析——若某祖先保留了 title，其后代禁止用 data-tip，
//    否则悬停后代时两个提示同时出现。因此父子必须同轨：迁移子元素前先检查祖先，
//    必要时把祖先一并迁走（.term-tab 与其 stop/close、.ew-recent-item 与其「×」即此例）；
//    反例：.tree-item 按规则 4 保留 title，故其内部 git 状态徽标也保留 title。
//
// 同一元素上 data-tip 与 title 不得共存（规则 5 的嵌套情形同样禁止）。

let tipEl: HTMLElement | null = null;
let showTimer: number | undefined;
let currentTarget: HTMLElement | null = null;
// UI-16：tooltip 模式——浮层 role="tooltip" + 固定 id，显示期间给触发元素挂
// aria-describedby 建立关联（WAI-ARIA APG：tooltip 须由被描述元素引用才可被读屏播报），
// 隐藏时还原元素原有的 aria-describedby（可能本来就描述其它内容，不能粗暴删除）
const TIP_ID = "oc-tooltip";
let describedEl: HTMLElement | null = null;
let prevDescribedBy: string | null = null;

function ensureTipEl(): HTMLElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "oc-tooltip hidden";
    tipEl.id = TIP_ID;
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/** 建立「触发元素 ← aria-describedby → 浮层」关联（保存原值供还原） */
function attachDescribedBy(el: HTMLElement): void {
  detachDescribedBy();
  describedEl = el;
  prevDescribedBy = el.getAttribute("aria-describedby");
  const ids = prevDescribedBy ? `${prevDescribedBy} ${TIP_ID}` : TIP_ID;
  el.setAttribute("aria-describedby", ids);
}

/** 解除关联并还原元素原有的 aria-describedby */
function detachDescribedBy(): void {
  if (!describedEl) return;
  if (prevDescribedBy === null) describedEl.removeAttribute("aria-describedby");
  else describedEl.setAttribute("aria-describedby", prevDescribedBy);
  describedEl = null;
  prevDescribedBy = null;
}

function hideTip(): void {
  tipEl?.classList.add("hidden");
  detachDescribedBy();
}

function showTipFor(el: HTMLElement): void {
  const tip = ensureTipEl();
  tip.textContent = "";
  tip.append(el.dataset.tip ?? "");
  const key = el.dataset.tipKey;
  if (key) {
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    tip.append(" ", kbd);
  }
  tip.classList.remove("hidden");
  attachDescribedBy(el);
  // 定位：默认目标下方居中，近底边翻转到上方，水平方向夹紧到视口内
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const left = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
  let top = r.bottom + 6;
  if (top + th > window.innerHeight - 6) top = Math.max(6, r.top - th - 6);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/** 接线 document 级委托（init 调用一次） */
export function wireTooltip(): void {
  document.addEventListener("mouseover", (e) => {
    const el = ((e.target as HTMLElement | null)?.closest("[data-tip]") as HTMLElement | null) ?? null;
    if (el === currentTarget) return;
    currentTarget = el;
    window.clearTimeout(showTimer);
    hideTip();
    if (!el) return;
    showTimer = window.setTimeout(() => showTipFor(el), 300);
  });
  // 按下即隐藏：点击反馈不被 tooltip 遮挡；失焦清理避免残留
  document.addEventListener("mousedown", () => {
    window.clearTimeout(showTimer);
    currentTarget = null;
    hideTip();
  });
  window.addEventListener("blur", () => {
    window.clearTimeout(showTimer);
    currentTarget = null;
    hideTip();
  });
}
