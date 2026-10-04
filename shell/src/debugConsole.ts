// 调试控制台 / 求值表达式（P1，PyCharm Debug Console + Alt+F8 对标）。
//
// 调试「能看」到「能问」的分水岭：断点处对任意表达式求值，并且**副作用真实发生**
// （DAP evaluate 的 context="repl"，等价于在暂停处敲一行 Python）。
//
// 三个产出：
//   1. 控制台区（#debug-console）：历史滚动区 + 输入行，Enter 求值，↑↓ 翻历史；
//   2. `output` 事件落到这里——**Logpoint 的输出就是 output 事件**（P0 已支持设 logpoint，
//      但没有承接方时用户什么也看不到）；脚本 stdout 仍走输出面板，不重复显示；
//   3. Alt+F8「求值表达式」：弹输入框（可预填编辑器选区），结果落到控制台。
//
// 只在 `stopped` 态可用：运行中求值得不到稳定上下文（debugpy 会直接报错）。

import { openAlert, openPrompt } from "./dialog";
import * as dap from "./dap/client";
import { currentFrameId } from "./debugView";
import { app } from "./state";
import { bindingLabel } from "./keybindings";
import { onLocaleChange, t } from "./i18n";

// ---------- DOM ----------

let logEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let initialized = false;

/** 输入历史（↑↓ 翻阅；最新在尾部） */
const history: string[] = [];
/** ↑↓ 翻阅游标：等于 history.length 表示「正在输入新行」 */
let histIdx = 0;

/** 初始化：把控制台区挂到调试侧栏（#view-debug）末尾 */
export function initDebugConsole(): void {
  if (initialized) return;
  const host = document.getElementById("view-debug");
  if (!host) return;
  initialized = true;

  const header = document.createElement("div");
  header.id = "debug-console-header";
  header.className = "debug-section-header";
  header.textContent = t("debug.console.title");

  const log = document.createElement("div");
  log.id = "debug-console-log";
  log.className = "debug-console-log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-label", t("debug.console.outputAria"));
  log.setAttribute("aria-live", "polite");

  const row = document.createElement("div");
  row.className = "debug-console-row";
  const input = document.createElement("input");
  input.id = "debug-console-input";
  input.type = "text";
  input.placeholder = t("debug.console.inputPlaceholder");
  input.spellcheck = false;
  input.autocomplete = "off";
  input.disabled = true;
  input.setAttribute("aria-label", t("debug.console.inputAria"));
  const btn = document.createElement("button");
  btn.id = "debug-console-run";
  btn.className = "btn btn--sm";
  btn.textContent = t("debug.console.evaluate");
  btn.disabled = true;
  row.append(input, btn);

  host.append(header, log, row);

  logEl = log;
  inputEl = input;

  input.addEventListener("keydown", (e) => {
    // 与全局 window 级快捷键隔离（Alt+F8 等不应在输入框里触发）
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void submit(input.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (histIdx > 0) input.value = history[--histIdx] ?? "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx < history.length - 1) input.value = history[++histIdx] ?? "";
      else {
        histIdx = history.length;
        input.value = "";
      }
    } else if (e.key === "Escape") {
      // 逃生口：焦点还给编辑器（全局 keydown 守卫会因焦点在 INPUT 而失效）
      input.blur();
      app.editor.focus();
    }
  });
  btn.addEventListener("click", () => void submit(input.value));

  dap.onPhase(() => syncEnabled());
  // Logpoint / evaluate 的回显都走 output 事件；脚本 stdout 已由输出面板承载（不重复）
  dap.onEvent("output", (body) => void onOutput(body));
  onLocaleChange(refreshDebugConsoleI18n);
  syncEnabled();
}

function refreshDebugConsoleI18n(): void {
  document.getElementById("debug-console-header")!.textContent = t("debug.console.title");
  logEl?.setAttribute("aria-label", t("debug.console.outputAria"));
  inputEl?.setAttribute("aria-label", t("debug.console.inputAria"));
  const btn = document.getElementById("debug-console-run");
  if (btn) btn.textContent = t("debug.console.evaluate");
  syncEnabled();
}

/** 仅 stopped 态可用（其余态求值得不到稳定上下文） */
function syncEnabled(): void {
  const enabled = dap.currentPhase() === "stopped";
  if (inputEl) {
    inputEl.disabled = !enabled;
    inputEl.placeholder = enabled
      ? t("debug.console.inputPlaceholder")
      : t("debug.console.availablePlaceholder");
  }
  const btn = document.getElementById("debug-console-run") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = !enabled;
    btn.classList.toggle("is-disabled", !enabled);
    btn.setAttribute("aria-disabled", String(!enabled));
  }
}

// ---------- 输出 ----------

type LineKind = "input" | "result" | "error" | "output";

function appendLine(kind: LineKind, text: string): void {
  const el = logEl;
  if (!el) return;
  const row = document.createElement("div");
  row.className = `debug-console-line dc-${kind}`;
  if (kind === "input") {
    const prompt = document.createElement("span");
    prompt.className = "dc-prompt";
    prompt.textContent = ">>> ";
    row.appendChild(prompt);
  }
  const body = document.createElement("span");
  body.className = "dc-text";
  // 逐行渲染（求值结果常含换行），不用 innerHTML
  for (const [i, line] of text.split("\n").entries()) {
    if (i > 0) row.appendChild(document.createElement("br"));
    row.appendChild(document.createTextNode(line));
  }
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

/** DAP output 事件：Logpoint 输出 / evaluate 回显 */
async function onOutput(body: { output?: string; category?: string }): Promise<void> {
  const text = body?.output;
  if (!text) return;
  appendLine(body.category === "stderr" ? "error" : "output", text.replace(/\n$/, ""));
}

// ---------- 求值 ----------

async function submit(raw: string): Promise<void> {
  const expr = raw.trim();
  if (!expr) return;
  if (inputEl) inputEl.value = "";
  if (history[history.length - 1] !== expr) history.push(expr);
  histIdx = history.length;
  await evaluate(expr);
}

/** 对表达式求值并把「表达式 + 结果」落到控制台 */
export async function evaluate(expr: string): Promise<void> {
  appendLine("input", expr);
  if (dap.currentPhase() !== "stopped") {
    appendLine("error", t("debug.console.notStopped"));
    return;
  }
  try {
    const r = await dap.dapEvaluate(expr, currentFrameId());
    appendLine("result", r.result);
  } catch (e) {
    appendLine("error", String(e instanceof Error ? e.message : e));
  }
}

/**
 * Alt+F8：弹出输入框求值。
 * 预填值取编辑器当前选区（选了 `foo.bar` 直接求值是最顺手的一条路径），
 * 无选区则留空由用户输入。
 */
export async function openEvaluatePrompt(): Promise<void> {
  const seed = selectedText();
  const expr = await openPrompt({
    title: t("debug.console.inputAria"),
    label: t("debug.console.promptLabel"),
    value: seed,
    placeholder: t("debug.console.promptPlaceholder"),
    okLabel: t("debug.console.evaluate"),
  });
  if (expr === null || !expr.trim()) return; // 取消 / 空输入：不打扰用户
  await evaluate(expr.trim());
}

/** 编辑器当前选中的文本（单行；多行选区返回空——不适合直接求值） */
function selectedText(): string {
  const sel = app.editor.getSelection();
  const model = app.editor.getModel();
  if (!sel || !model || sel.startLineNumber !== sel.endLineNumber) return "";
  return model.getValueInRange(sel).trim();
}

export function clearDebugConsole(): void {
  if (logEl) logEl.textContent = "";
}

/** 非暂停态按下 Alt+F8 时的统一提示 */
export async function notifyNotPaused(): Promise<void> {
  const shortcut = bindingLabel("debug") || "F5";
  await openAlert({
    title: t("debug.common.evaluateFailed"),
    message: t("debug.console.notPausedMessage", { shortcut }),
  });
}
