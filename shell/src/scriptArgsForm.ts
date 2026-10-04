// 脚本参数表单（库特别支持 PR-4，docs/python_library_support_dev_plan.md §6 + research §11.5）。
// 运行面板内嵌（D-3 裁决，不新增侧栏视图）：静态解析（ast_argparse kind）→ 表单 → 命令行拼装；
// 手工编辑命令行 → 尽力回填，inconsistent 标注「以命令行为准」，绝不静默覆盖（§11.5 纪律）。
// 三态：无参数 / 成功 / 解析失败退化纯输入框——都不阻止运行。

import { invoke } from "@tauri-apps/api/core";
import { $, app } from "./state";
import { openConfirm } from "./dialog";
import { evalKind } from "./libEval";
import {
  backfillFromCommandLine,
  buildCommandLine,
  isMultiNargs,
  missingRequired,
  toFormModel,
  type AstArgsData,
  type FormValue,
  type ScriptParam,
} from "./scriptArgs";
import { toast } from "./toast";
import { t } from "./i18n"; // 第五批 i18n：脚本参数表单动态文案走语言包
import { errMsg } from "./util";
import { localizeBackendError } from "./i18n/backendError";

const container = $("run-config-args-form") as HTMLElement;
// 内省按钮提示：渲染期经 t() 现算（不放模块级常量——语言切换后常量会过期）

// ---------- 模块状态（面板每次打开重渲染） ----------
let params: ScriptParam[] = [];
let values: Record<string, FormValue> = {};
let rendering = false; // 回填写控件时抑制 input 循环
let scriptPath: string | null = null;

/**
 * 渲染脚本参数区（运行面板打开 / 分区切换时调用）。
 * @param path 脚本分区目标文件（null = 非脚本分区，清空区域）
 */
export async function renderScriptArgs(path: string | null, argsInput: HTMLInputElement): Promise<void> {
  scriptPath = path;
  container.textContent = "";
  container.classList.add("hidden");
  params = [];
  values = {};
  if (!path) return;
  // §11.9：libs_argparse 关闭 → 运行面板不显示参数区（开关四处接线已齐，此处是 UI 侧落点）
  if (app.settings.libs_argparse === false) return;
  if (!argsInput.dataset.raWired) {
    argsInput.dataset.raWired = "1";
    argsInput.addEventListener("input", () => void onArgsEdited(argsInput));
  }

  let data: AstArgsData | null = null;
  let failed = false;
  try {
    const code = await invoke<string>("read_file", { path });
    const res = await evalKind<AstArgsData>("ast_argparse", { code }, { workspaceRoot: app.workspaceRoot ?? "" });
    if (res.state === "ok") data = res.data ?? null;
    else failed = true;
  } catch {
    failed = true;
  }

  // 本次渲染期间面板已切走（scriptPath 变了）→ 丢弃
  if (scriptPath !== path) return;

  params = toFormModel(data);
  container.classList.remove("hidden");
  if (failed) {
    renderNote(t("run.args.parseFailed"), "rx-status--degraded");
    return; // 三态 ③：退化纯输入框，不阻止运行
  }
  if (params.length === 0) {
    renderNote(t("run.args.noParams"), "rx-status--idle");
    return; // 三态 ①：空态
  }
  renderRows(argsInput);
}

function renderNote(text: string, cls: string): void {
  const note = document.createElement("div");
  note.className = `rx-status ${cls}`;
  note.id = "ra-note";
  note.textContent = text;
  container.appendChild(note);
}

/** 类型 → 控件映射（§11.5）：choices→下拉 · bool→勾选 · int/float→数字框 · 其余→文本框 */
function renderRows(argsInput: HTMLInputElement, introspected = false): void {
  container.textContent = "";
  const head = document.createElement("div");
  head.className = "ra-head";
  head.id = "ra-head";
  const info = document.createElement("span");
  info.className = "rx-flags-summary";
  info.textContent = t("run.args.parsedFromSource", { count: params.length, suffix: introspected ? t("run.args.introspectMerged") : "" });
  head.appendChild(info);
  const introBtn = document.createElement("button");
  introBtn.type = "button";
  introBtn.className = "btn ra-introspect";
  introBtn.id = "ra-introspect";
  introBtn.textContent = t("run.args.introspectBtn");
  introBtn.dataset.tip = t("run.args.introspectTip");
  introBtn.setAttribute("aria-label", t("run.args.introspectTip"));
  introBtn.addEventListener("click", () => void runIntrospect(argsInput));
  head.appendChild(introBtn);
  container.appendChild(head);

  for (const p of params) {
    container.appendChild(renderRow(p, argsInput));
  }
  const syncNote = document.createElement("div");
  syncNote.className = "rx-status rx-status--idle hidden";
  syncNote.id = "ra-sync-note";
  container.appendChild(syncNote);
}

function renderRow(p: ScriptParam, argsInput: HTMLInputElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "ra-row";
  row.dataset.name = p.name;
  const label = document.createElement("label");
  label.className = "ra-label";
  label.textContent = p.name;
  label.htmlFor = `ra-${p.name}`;
  if (p.help) {
    row.dataset.tip = p.help;
    label.title = p.help;
  }
  row.appendChild(label);

  const cur = values[p.name];
  let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (p.type === "bool") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `ra-${p.name}`;
    cb.className = "ra-check";
    cb.checked = cur === true;
    cb.addEventListener("change", () => {
      values[p.name] = cb.checked;
      applyToArgs(argsInput);
    });
    control = cb;
  } else if (p.choices) {
    const sel = document.createElement("select");
    sel.id = `ra-${p.name}`;
    sel.className = "ra-select";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = p.default != null ? String(p.default) : t("run.args.notSelected");
    sel.appendChild(empty);
    for (const c of p.choices) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    }
    sel.value = typeof cur === "string" && cur ? cur : "";
    sel.addEventListener("change", () => {
      values[p.name] = sel.value;
      applyToArgs(argsInput);
    });
    control = sel;
  } else if (isMultiNargs(p)) {
    // nargs='*' / '+' / N：多行文本（空格或逗号分隔多个值，§11.5）
    const ta = document.createElement("textarea");
    ta.id = `ra-${p.name}`;
    ta.className = "ra-input ra-multi";
    ta.rows = 2;
    ta.placeholder = p.default != null ? String(p.default) : t("run.args.multiPlaceholder");
    if (typeof cur === "string") ta.value = cur;
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.addEventListener("input", () => {
      values[p.name] = ta.value;
      applyToArgs(argsInput);
    });
    control = ta;
  } else {
    const input = document.createElement("input");
    input.type = p.type === "int" || p.type === "float" ? "number" : "text";
    input.id = `ra-${p.name}`;
    if (p.type === "float") input.step = "any";
    input.className = "ra-input";
    // default 作占位符（不是值，§11.5：避免默认值被当成显式输入提交）
    input.placeholder = p.default != null ? String(p.default) : "";
    if (typeof cur === "string") input.value = cur;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.addEventListener("input", () => {
      values[p.name] = input.value;
      applyToArgs(argsInput);
    });
    control = input;
  }
  row.appendChild(control);

  const tag = document.createElement("span");
  tag.className = "rx-flags-summary";
  const nargsTag = p.nargs ? ` nargs=${p.nargs}` : "";
  tag.textContent = p.type === "bool" ? "bool" : p.type + nargsTag + (p.required ? t("run.args.requiredTag") : "");
  row.appendChild(tag);
  return row;
}

/** 表单 → 命令行（覆盖 args 输入框；required 缺参给内联提示但不阻止运行） */
function applyToArgs(argsInput: HTMLInputElement): void {
  rendering = true;
  argsInput.value = buildCommandLine(params, values);
  rendering = false;
  const syncNote = document.getElementById("ra-sync-note");
  if (syncNote) {
    syncNote.classList.add("hidden");
    syncNote.textContent = "";
  }
  const missing = missingRequired(params, values);
  const head = document.getElementById("ra-head");
  if (head) {
    let req = document.getElementById("ra-required-note");
    if (missing.length > 0) {
      if (!req) {
        req = document.createElement("span");
        req.id = "ra-required-note";
        req.className = "rx-status--err";
        head.appendChild(req);
      }
      req.textContent = t("run.args.missingInline", { names: missing.join("、") });
      req.classList.remove("hidden");
    } else if (req) {
      req.classList.add("hidden");
    }
  }
}

/**
 * 提交（保存运行配置）时的必填校验：缺参 toast 指出缺哪个（§11.5）。
 * 无参数表 / 解析失败退化态恒通过——三态都不阻止运行。
 */
export function validateScriptArgs(): boolean {
  if (params.length === 0) return true;
  const missing = missingRequired(params, values);
  if (missing.length === 0) return true;
  toast(t("run.args.missingToast", { names: missing.join("、") }), "error");
  return false;
}

/** 命令行被手工编辑 → 尽力回填；inconsistent 标注「以命令行为准」（绝不覆盖表单） */
async function onArgsEdited(argsInput: HTMLInputElement): Promise<void> {
  if (rendering || params.length === 0) return;
  const r = backfillFromCommandLine(params, argsInput.value);
  const syncNote = document.getElementById("ra-sync-note");
  if (r.inconsistent || r.values === null) {
    if (syncNote) {
      syncNote.textContent = t("run.args.inconsistent");
      syncNote.classList.remove("hidden");
    }
    return;
  }
  if (syncNote) syncNote.classList.add("hidden");
  values = r.values;
  rendering = true;
  for (const p of params) {
    const el = document.getElementById(`ra-${p.name}`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!el) continue;
    const v = values[p.name];
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      el.checked = v === true;
    } else {
      el.value = typeof v === "string" ? v : "";
    }
  }
  rendering = false;
}

/** 内省（默认关）：openConfirm 确认副作用 → 独立子进程（Rust 侧 5s 超时）→ 合并默认值 */
async function runIntrospect(argsInput: HTMLInputElement): Promise<void> {
  if (!scriptPath || !app.workspaceRoot) return;
  const ok = await openConfirm({
    message: t("run.args.introspectConfirm"),
    kind: "primary",
  });
  if (!ok) return;
  const res = await evalKind<AstArgsData>("ast_introspect", { path: scriptPath }, { workspaceRoot: app.workspaceRoot });
  if (res.state !== "ok" || !res.data) {
    const note = document.getElementById("ra-note") ?? document.createElement("div");
    note.id = "ra-note";
    note.className = "rx-status rx-status--err";
    note.textContent = t("run.args.introspectFailed", { error: localizeBackendError(errMsg(res.error ?? t("run.args.unknownError"))) });
    if (!note.parentElement) container.appendChild(note);
    return;
  }
  const runtime = toFormModel(res.data);
  // 合并：以 name 为键更新 default（用户已填的值不动）
  for (const p of runtime) {
    const cur = params.find((x) => x.name === p.name);
    if (cur) cur.default = p.default;
  }
  renderRows(argsInput, true);
}
