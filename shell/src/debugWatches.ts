// Watches 监视表达式（B-1，PyCharm 调研）。
//
// 与 Debug Console 的区别：Console 是一次性求值（repl，有副作用）；
// Watches 是**持久化的表达式列表**，每次暂停 / 切帧都自动重新求值（context="watch"，
// 无副作用语义），让你跨断点盯住几个关键变量。
//
// 存储：localStorage（上限 20 条，G-1 红线）——低频个人配置，跨重启保留；
// 将来若要跨设备同步可迁 Rust 侧（同断点/书签模式），结构不变。
//
// 与 debugView 的协作：debugView 持有帧真值，经 initWatchesPanel(host, getFrameId) 注入
// 面板宿主与取帧回调，并在 refreshVariables 末尾调 refreshWatches——
// 本模块不反向 import debugView（防环）。

import { dapEvaluate } from "./dap/client";
import { toast } from "./toast";
import { onLocaleChange, t } from "./i18n";

const STORE_KEY = "oc-debug-watches";
const MAX_WATCHES = 20;
/** 值显示截断（完整值挂 title） */
const MAX_VALUE_LEN = 200;

let watches: string[] = load();
let getFrameId: () => number | null = () => null;
/** 刷新令牌（快速切帧时旧求值循环作废） */
let watchToken = 0;

/** 面板宿主与列表容器（initWatchesPanel 注入；DOM 由 debugView 动态构建） */
let sectionEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, MAX_WATCHES) : [];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(watches.slice(0, MAX_WATCHES)));
  } catch {
    /* 存储不可用静默（内存里的列表仍然可用） */
  }
}

/** 单条结果行（value=null 表示占位，求值完成后填充） */
function renderRow(expr: string, value: string | null, failed: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "debug-watch-row";
  const exprEl = document.createElement("span");
  exprEl.className = "debug-watch-expr";
  exprEl.textContent = expr;
  const valEl = document.createElement("span");
  valEl.className = failed ? "debug-watch-value debug-watch-value-failed" : "debug-watch-value";
  if (value === null) valEl.textContent = "…";
  else {
    valEl.textContent = value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN - 1)}…` : value;
    valEl.title = value;
  }
  const del = document.createElement("span");
  del.className = "debug-watch-del";
  del.setAttribute("role", "button");
  del.dataset.watchExpr = expr;
  del.setAttribute("aria-label", t("debug.watch.deleteAria", { expr: expr }));
  del.tabIndex = 0;
  del.dataset.tip = t("debug.watch.delete");
  del.textContent = "×";
  const doRemove = (): void => {
    removeWatch(expr);
  };
  del.addEventListener("click", doRemove);
  del.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      doRemove();
    }
  });
  row.append(exprEl, valEl, del);
  return row;
}

function render(): void {
  if (!sectionEl || !listEl) return;
  sectionEl.textContent = "";
  const title = document.createElement("div");
  title.className = "debug-section-header";
  title.textContent = t("debug.watch.title");
  sectionEl.appendChild(title);

  const input = document.createElement("input");
  input.className = "debug-watch-input";
  input.type = "text";
  input.placeholder = t("debug.watch.inputPlaceholder");
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", t("debug.watch.inputAria"));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = input.value.trim();
    if (!v) return;
    if (!watches.includes(v) && watches.length >= MAX_WATCHES) {
      toast(t("debug.watch.limit", { count: MAX_WATCHES }), "info"); // G-3：拒绝要可见
      return;
    }
    if (!watches.includes(v)) watches.push(v);
    input.value = "";
    save();
    void refreshWatches(getFrameId());
  });
  sectionEl.appendChild(input);

  listEl.textContent = "";
  if (watches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "debug-watch-empty";
    empty.textContent = t("debug.watch.empty");
    listEl.appendChild(empty);
  } else {
    for (const expr of watches) listEl.appendChild(renderRow(expr, null, false));
  }
}

/** 语言切换只更新现有节点的产品文案，不重置表达式/结果，也不重新触发 DAP 求值。 */
function refreshWatchesI18n(): void {
  if (!sectionEl || !listEl) return;
  sectionEl.querySelector<HTMLElement>(".debug-section-header")!.textContent = t("debug.watch.title");
  const input = sectionEl.querySelector<HTMLInputElement>(".debug-watch-input");
  if (input) {
    input.placeholder = t("debug.watch.inputPlaceholder");
    input.setAttribute("aria-label", t("debug.watch.inputAria"));
  }
  const empty = listEl.querySelector<HTMLElement>(".debug-watch-empty");
  if (empty) empty.textContent = t("debug.watch.empty");
  for (const del of Array.from(listEl.querySelectorAll<HTMLElement>("[data-watch-expr]"))) {
    const expr = del.dataset.watchExpr ?? "";
    del.dataset.tip = t("debug.watch.delete");
    del.setAttribute("aria-label", t("debug.watch.deleteAria", { expr }));
  }
  for (const value of Array.from(listEl.querySelectorAll<HTMLElement>(".debug-watch-value-failed"))) {
    value.textContent = t("debug.common.evaluateFailed");
  }
}

function removeWatch(expr: string): void {
  watches = watches.filter((x) => x !== expr);
  save();
  render();
  void refreshWatches(getFrameId());
}

/** 批量求值并刷新列表（暂停态有效；串行求值——数量小，避免打爆适配器）。
 *  帧切换后旧值必须立刻让位：重画为占位后逐条填值。
 *  令牌防护：连续两次 refresh（快速切帧）时旧循环的求值结果不得写入新列表。 */
export async function refreshWatches(frameId: number | null): Promise<void> {
  if (!sectionEl || !listEl || watches.length === 0) return;
  const token = ++watchToken;
  listEl.textContent = "";
  const rows = new Map<string, HTMLElement>();
  for (const expr of watches) {
    const row = renderRow(expr, null, false);
    rows.set(expr, row);
    listEl.appendChild(row);
  }
  for (const expr of watches) {
    if (token !== watchToken) return; // 已被更新的刷新取代
    const row = rows.get(expr);
    if (!row) continue;
    const valEl = row.querySelector(".debug-watch-value") as HTMLElement | null;
    try {
      const r = await dapEvaluate(expr, frameId, "watch");
      if (token !== watchToken) return; // 求值期间列表已被重画
      if (valEl) {
        const v = r.result.length > MAX_VALUE_LEN ? `${r.result.slice(0, MAX_VALUE_LEN - 1)}…` : r.result;
        valEl.textContent = v;
        valEl.title = r.result;
      }
    } catch {
      if (token !== watchToken) return;
      if (valEl) {
        valEl.textContent = t("debug.common.evaluateFailed");
        valEl.title = "";
        valEl.classList.add("debug-watch-value-failed");
      }
    }
  }
}

/** 会话结束：清值（表达式保留，下次暂停重新求值）。
 *  P3-4（2026-09-29 review）：同时作废在途刷新令牌——此前 clearWatchesValues 只重写
 *  DOM，会话结束后仍在跑的 refreshWatches 循环会把行值改回「无法求值」，盖掉清场
 *  写入的「—」；令牌 +1 让旧循环在下个检查点退出。 */
export function clearWatchesValues(): void {
  watchToken++;
  if (!listEl) return;
  for (const el of Array.from(listEl.querySelectorAll(".debug-watch-value"))) el.textContent = "—";
}

/** 接线（debugView::initDebugView 调用一次）：注入面板宿主与取帧回调 */
export function initWatchesPanel(host: HTMLElement, frameIdGetter: () => number | null): void {
  if (sectionEl) return;
  sectionEl = host;
  getFrameId = frameIdGetter;
  listEl = document.createElement("div");
  listEl.id = "debug-watch-list";
  render();
  host.appendChild(listEl);
  onLocaleChange(refreshWatchesI18n);
}
