// 运行配置面板域（v3.4 §17-6 / M3-3.6：两分区）。
//
// - 面板分「脚本配置（当前文件）」/「项目配置」两个分区（左侧分区切换 + 右侧编辑器）；
// - 命名配置列表、新建 / 复制 / 删除 / 临时升格已随 v3.4 §17-14 删除；
// - 保存路由：脚本分区 → set_run_config（键 = 文件相对路径，后端解析）；项目分区 →
//   set_project_run（固定键 project_run；入口清空保存 = 移除配置）；
// - v2 高级项（stdin 三档 / allow_multiple / auto_rerun / python_console / open_browser_url /
//   pre_run_profile）的 UI 与 TS 类型已删（§18 裁决 3）。

import { invoke } from "@tauri-apps/api/core";
import { app, $, $btn, outputEl } from "./state";
import { setBusy } from "./util";
import { appendOutputLine } from "./output";
import { gotoFromLink } from "./tracebackLink";
import { hideEl, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { basename, errMsg, relativePathRaw } from "./util";
import { onLocaleChange, t } from "./i18n"; // 第五批 i18n：运行配置面板动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { toast, toastFail } from "./toast";
import { EMPTY_RUN_CONFIG, normalizeRunConfig, type EnvVar, type RunConfig, type RunEntry } from "./runState";
import { createCombobox, type Combobox, type ComboboxItem } from "./combobox";
import { renderScriptArgs, validateScriptArgs } from "./scriptArgsForm"; // 库支持 PR-4：脚本参数表单（D-3 内嵌）

// ---------- 域内 DOM ----------

const runConfigModalEl = $("run-config-modal");
const runConfigListEl = $("run-config-list");
const runConfigContextEl = $("run-config-context");
const runConfigSecScriptBtn = $btn("run-config-sec-script");
const runConfigSecProjectBtn = $btn("run-config-sec-project");
const runConfigEntryKindEl = $("run-config-entry-kind") as HTMLSelectElement;
const runConfigTargetInputEl = $("run-config-target-input") as HTMLInputElement;
const runConfigTargetLabelEl = $("run-config-target-label");
const runConfigArgsEl = $("run-config-args") as HTMLInputElement;
const runConfigCwdEl = $("run-config-cwd") as HTMLInputElement;
const runConfigEnvEl = $("run-config-env") as HTMLTextAreaElement;
const runConfigEnvFilesEl = $("run-config-env-files") as HTMLTextAreaElement;
const runConfigInterpreterEl = $("run-config-interpreter") as HTMLInputElement;
const runConfigTargetDropEl = $("run-config-target-drop");
const runConfigCwdDropEl = $("run-config-cwd-drop");
const runConfigInterpreterDropEl = $("run-config-interpreter-drop");
const runConfigEnvFilesAddEl = $btn("run-config-env-files-add");
/** P1-F：字段级内联校验提示（就近显示在入口输入框下方，不再进输出面板） */
const runConfigFieldErrorEl = $("run-config-field-error");

/** P1-F：显示字段级错误（入口输入框下方的内联提示） */
function showFieldError(msg: string): void {
  runConfigFieldErrorEl.textContent = msg;
  runConfigFieldErrorEl.classList.remove("hidden");
}

/** P1-F：清除字段级错误（输入/分区切换/保存成功时调用） */
function clearFieldError(): void {
  if (runConfigFieldErrorEl.classList.contains("hidden")) return;
  runConfigFieldErrorEl.textContent = "";
  runConfigFieldErrorEl.classList.add("hidden");
}

/** 当前分区：脚本配置（当前文件）| 项目配置 */
type Section = "script" | "project";
let section: Section = "script";
/** list_pythons 返回的解释器条目（仅取候选所需字段，与 env_cmds PythonInfo 对齐） */
interface PythonInfo { path: string; version: string; kind: string; is_selected: boolean }
/** 脚本分区的目标文件（打开面板时的活动 .py 文件；null = 无活动文件，保存禁用） */
let scriptTargetPath: string | null = null;
/** UI-05：模态焦点陷阱解除句柄，关闭时置 null */
let releaseRunConfigFocus: (() => void) | null = null;

// ---------- 分区切换 ----------

/** 重绘左侧分区指示（列表区：当前分区高亮 + 脚本分区的目标文件名） */
function renderSections(): void {
  runConfigSecScriptBtn.classList.toggle("active", section === "script");
  runConfigSecScriptBtn.setAttribute("aria-selected", String(section === "script"));
  runConfigSecProjectBtn.classList.toggle("active", section === "project");
  runConfigSecProjectBtn.setAttribute("aria-selected", String(section === "project"));
  runConfigListEl.textContent = "";
  if (section === "script") {
    const li = document.createElement("li");
    li.className = "run-config-list-item selected";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "true");
    const name = document.createElement("span");
    name.className = "rcl-name";
    name.textContent = scriptTargetPath ? basename(scriptTargetPath) : t("run.cfg.noActivePy");
    li.appendChild(name);
    const tag = document.createElement("span");
    tag.className = "rcl-tag";
    tag.textContent = t("run.cfg.tagPerFile");
    li.appendChild(tag);
    runConfigListEl.appendChild(li);
    runConfigContextEl.textContent = scriptTargetPath ?? t("run.cfg.noPyOpen");
  } else {
    const li = document.createElement("li");
    li.className = "run-config-list-item selected";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "true");
    const name = document.createElement("span");
    name.className = "rcl-name";
    name.textContent = t("run.cfg.projectEntry");
    li.appendChild(name);
    const tag = document.createElement("span");
    tag.className = "rcl-tag";
    tag.textContent = t("run.cfg.tagPerProject");
    li.appendChild(tag);
    runConfigListEl.appendChild(li);
    runConfigContextEl.textContent = app.workspaceRoot ? basename(app.workspaceRoot) : "—";
  }
}

/** 切换分区并重载配置 */
async function switchSection(sec: Section): Promise<void> {
  if (section === sec) return;
  section = sec;
  clearFieldError();
  renderSections();
  await loadSection(sec);
}

// ---------- 右侧编辑器 ----------

/** 把一份配置填进编辑器字段（v3.4 §17-6：v2 高级项与 stdin 字段已删） */
function fillEditor(cfg: RunConfig): void {
  runConfigEntryKindEl.value = cfg.entry.kind;
  runConfigTargetInputEl.value = cfg.entry.target;
  syncEntryTargetLabel();
  runConfigArgsEl.value = cfg.args;
  runConfigCwdEl.value = cfg.cwd;
  runConfigEnvFilesEl.value = cfg.env_files.filter((p) => p.trim()).join("\n");
  runConfigInterpreterEl.value = cfg.interpreter;
  runConfigEnvEl.value = cfg.env.map((kv) => `${kv.key}=${kv.value}`).join("\n");
}

/** 入口类型切换：模块名 / 脚本路径 的 label 与 placeholder（脚本分区锁定为当前文件） */
function syncEntryTargetLabel(): void {
  const isModule = runConfigEntryKindEl.value === "module";
  if (section === "script") {
    // 脚本配置：入口恒为当前文件（§4.1「entry —（恒为文件本身）」），类型与目标均锁定
    runConfigTargetLabelEl.textContent = t("run.cfg.scriptCurrentFile");
    runConfigTargetInputEl.placeholder = scriptTargetPath ?? t("run.cfg.noActivePy");
    runConfigTargetInputEl.disabled = true;
    runConfigTargetInputEl.value = scriptTargetPath ? basename(scriptTargetPath) : "";
    runConfigEntryKindEl.value = "script";
    runConfigEntryKindEl.disabled = true;
    targetCombo?.setEnabled(false); // 脚本入口恒为当前文件，无需补全
  } else {
    runConfigTargetLabelEl.textContent = isModule ? t("run.cfg.moduleName") : t("run.cfg.scriptPath");
    runConfigTargetInputEl.placeholder = isModule ? "uvicorn" : t("run.cfg.scriptPlaceholder");
    runConfigTargetInputEl.disabled = false;
    runConfigEntryKindEl.disabled = false;
    targetCombo?.setEnabled(!isModule); // 仅脚本入口需要文件补全；模块入口填模块名
  }
}

// ---------- 路径 / 解释器选择辅助（combobox） ----------

/** 归一化拾取路径（正斜杠）：工作区内 → 相对工作区根；区外 → 绝对路径 */
function normalizePicked(root: string, picked: string): string {
  const rel = relativePathRaw(root, picked);
  return (rel ?? picked).replace(/\\/g, "/");
}

/** 三个组合框实例（wireRunConfigPanel 创建；openRunConfig 时 invalidate） */
let targetCombo: Combobox | null = null;
let cwdCombo: Combobox | null = null;
let interpreterCombo: Combobox | null = null;

/** 解释器候选：「跟随工作区解释器（清空）」+ list_pythons 检测项 */
async function provideInterpreterCandidates(): Promise<ComboboxItem[]> {
  const out: ComboboxItem[] = [
    { label: t("run.cfg.followWorkspace"), value: "", detail: t("run.cfg.followWorkspaceDetail") },
  ];
  if (!app.workspaceRoot) return out;
  let pythons: PythonInfo[] = [];
  try {
    pythons = await invoke<PythonInfo[]>("list_pythons", { workspaceRoot: app.workspaceRoot });
  } catch (e) {
    toastFail(t("run.cfg.failReadInterpreters"), e);
  }
  for (const p of pythons) {
    const kind = p.kind === "workspace-venv" ? t("run.cfg.kindWorkspaceVenv") : p.kind === "manual" ? t("run.cfg.kindManual") : t("run.cfg.kindSystem");
    out.push({ label: `${kind}${p.version ? " " + p.version : ""}`, detail: p.path, value: p.path });
  }
  return out;
}

/** 工作目录候选：「${workspaceRoot}（工作区根）」+ list_workspace_dirs 子目录 */
async function provideCwdCandidates(): Promise<ComboboxItem[]> {
  const out: ComboboxItem[] = [
    { label: "${workspaceRoot}", detail: t("run.cfg.workspaceRoot"), value: "${workspaceRoot}" },
  ];
  if (!app.workspaceRoot) return out;
  let dirs: string[] = [];
  try {
    dirs = await invoke<string[]>("list_workspace_dirs", { root: app.workspaceRoot });
  } catch (e) {
    toastFail(t("run.cfg.failReadDirs"), e);
  }
  for (const d of dirs) {
    out.push({ label: d, detail: "${workspaceRoot}/" + d, value: "${workspaceRoot}/" + d });
  }
  return out;
}

/** 脚本路径候选：list_workspace_files 里的 .py/.pyw（相对工作区根） */
async function provideScriptCandidates(): Promise<ComboboxItem[]> {
  if (!app.workspaceRoot) return [];
  let files: string[] = [];
  try {
    files = await invoke<string[]>("list_workspace_files", { root: app.workspaceRoot });
  } catch (e) {
    toastFail(t("run.cfg.failReadFiles"), e);
  }
  const root = app.workspaceRoot;
  const out: ComboboxItem[] = [];
  for (const f of files) {
    if (!f.endsWith(".py") && !f.endsWith(".pyw")) continue;
    const rel = (relativePathRaw(root, f) ?? basename(f)).replace(/\\/g, "/");
    out.push({ label: basename(f), detail: rel, value: rel });
  }
  return out;
}

/** 解释器「浏览…」：选任意解释器可执行文件，填绝对路径 */
async function browseInterpreter(): Promise<void> {
  const picked = await invoke<string | null>("pick_file").catch(() => null);
  if (picked) runConfigInterpreterEl.value = picked;
}

/** 项目脚本入口：选择 .py 文件并回填（区内相对路径 / 区外绝对路径） */
async function browseTargetScript(): Promise<void> {
  if (!app.workspaceRoot) return;
  const picked = await invoke<string | null>("pick_file").catch(() => null);
  if (picked) runConfigTargetInputEl.value = normalizePicked(app.workspaceRoot, picked);
}

/** 工作目录：选择目录并回填；区内展开为 ${workspaceRoot} 宏，跨机器稳定 */
async function browseCwd(): Promise<void> {
  if (!app.workspaceRoot) return;
  const picked = await invoke<string | null>("pick_folder").catch(() => null);
  if (!picked) return;
  const p = picked.replace(/\\/g, "/");
  const normRoot = app.workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p.toLowerCase() === normRoot.toLowerCase()) {
    runConfigCwdEl.value = "${workspaceRoot}";
  } else if (p.toLowerCase().startsWith(normRoot.toLowerCase() + "/")) {
    runConfigCwdEl.value = "${workspaceRoot}/" + p.slice(normRoot.length + 1);
  } else {
    runConfigCwdEl.value = p;
  }
}

/** .env 文件：选择文件并追加一行（去重） */
async function addEnvFile(): Promise<void> {
  if (!app.workspaceRoot) return;
  const picked = await invoke<string | null>("pick_file").catch(() => null);
  if (!picked) return;
  const line = normalizePicked(app.workspaceRoot, picked);
  const cur = runConfigEnvFilesEl.value.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (!cur.includes(line)) {
    cur.push(line);
    runConfigEnvFilesEl.value = cur.join("\n");
  }
}

/** 载入当前分区的配置 */
async function loadSection(sec: Section): Promise<void> {
  if (!app.workspaceRoot) return;
  if (sec === "project") {
    const project = await invoke<Partial<RunConfig> | null>("get_project_run", { workspaceRoot: app.workspaceRoot })
      .catch(() => null);
    fillEditor(project ? normalizeRunConfig(project) : EMPTY_RUN_CONFIG);
  } else {
    const path = scriptTargetPath;
    if (!path) {
      fillEditor(EMPTY_RUN_CONFIG);
    } else {
      const cfg = await invoke<Partial<RunConfig>>("get_run_config", { workspaceRoot: app.workspaceRoot, scriptPath: path })
        .catch(() => ({}) as Partial<RunConfig>);
      fillEditor(normalizeRunConfig(cfg));
    }
  }
  syncEntryTargetLabel();
  // 库支持 PR-4：脚本参数表单（D-3 内嵌；仅脚本分区，project 分区清空）
  void renderScriptArgs(sec === "script" ? scriptTargetPath : null, runConfigArgsEl);
}

// ---------- 面板开合 ----------

/**
 * 打开运行配置面板（v3.4 §17-6 M3-3.6：两分区——脚本配置（当前文件）/ 项目配置）。
 * `path` 用于脚本分区的目标文件（活动 .py 文件；非 .py 或缺省时脚本分区只读提示）。
 * `focusArgs`（库支持 PR-4）：lens「⚙ N 个参数」入口 → 打开后聚焦参数区（D-3）。
 */
export async function openRunConfig(path?: string, focusArgs?: boolean): Promise<void> {
  if (!app.workspaceRoot) {
    toast(t("run.cfg.needWorkspace"), "info");
    return;
  }
  scriptTargetPath = path && (path.endsWith(".py") || path.endsWith(".pyw")) ? path : (app.activeTab?.path ?? null);
  if (scriptTargetPath && !(scriptTargetPath.endsWith(".py") || scriptTargetPath.endsWith(".pyw"))) {
    scriptTargetPath = null;
  }
  clearFieldError();
  showEl(runConfigModalEl);
  // 工作区可能已切换：作废三个组合框的候选缓存，下次展开重拉
  targetCombo?.invalidate();
  cwdCombo?.invalidate();
  interpreterCombo?.invalidate();
  releaseRunConfigFocus?.();
  releaseRunConfigFocus = trapFocus(runConfigModalEl);
  document.addEventListener("keydown", onRunConfigKeydown);
  renderSections();
  await loadSection(section);
  (focusArgs ? runConfigArgsEl : runConfigTargetInputEl).focus();
}

function closeRunConfig(): void {
  targetCombo?.close();
  cwdCombo?.close();
  interpreterCombo?.close();
  releaseRunConfigFocus?.();
  releaseRunConfigFocus = null;
  document.removeEventListener("keydown", onRunConfigKeydown);
  hideEl(runConfigModalEl);
}

/** Esc 关闭配置面板（点外部不关闭后，Esc 是键盘关闭入口之一，与 X /「关闭」按钮并列）。
 *  守卫：前台还有更上层对话框（openConfirm/openAlert/openPrompt/openChoice 均走 .modal 显隐
 *  约定）时 Esc 归对话框——其处理器挂在按钮 keydown 上，事件仍会冒泡到 document，不挡会
 *  连带关掉底下的配置面板、丢失未保存编辑（与 envPanel.onEnvKeydown / bookmarks 同款守卫）。 */
function onRunConfigKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (document.querySelectorAll(".modal:not(.hidden)").length > 1) return;
  closeRunConfig();
}

// ---------- 保存 ----------

/** 解析环境变量文本（每行 KEY=VALUE，忽略空行与无 '=' 的行）为 EnvVar[] */
function parseEnvText(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // 无 '=' 或空键 → 跳过
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return out;
}

/** P1-G：解析 .env 文件列表文本（每行一个路径，忽略空行；按序加载） */
function parseEnvFilesText(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function saveRunConfig(): Promise<void> {
  if (!app.workspaceRoot) return;
  const entryKind: RunEntry["kind"] = section === "script"
    ? "script"
    : runConfigEntryKindEl.value === "module" ? "module" : "script";
  const entryTarget = section === "script"
    ? (scriptTargetPath ?? "")
    : runConfigTargetInputEl.value.trim();
  if (section === "script" && !entryTarget) {
    showFieldError(t("run.cfg.needActivePy"));
    return;
  }
  if (section === "project" && entryKind === "module" && !entryTarget) {
    showFieldError(t("run.cfg.needModuleName"));
    runConfigTargetInputEl.focus();
    return;
  }
  if (section === "project" && entryKind === "script" && !entryTarget) {
    showFieldError(t("run.cfg.needScriptPath"));
    runConfigTargetInputEl.focus();
    return;
  }
  // 库支持 PR-4：必填参数校验（§11.5 提交时校验，缺参 toast 指出缺哪个）
  if (section === "script" && !validateScriptArgs()) return;
  clearFieldError();
  const config: RunConfig = {
    entry: { kind: entryKind, target: entryTarget },
    args: runConfigArgsEl.value,
    cwd: runConfigCwdEl.value.trim(),
    env: parseEnvText(runConfigEnvEl.value),
    env_files: parseEnvFilesText(runConfigEnvFilesEl.value),
    interpreter: runConfigInterpreterEl.value.trim(),
  };

  const saveBtn = $btn("run-config-save");
  setBusy(saveBtn, true, t("run.cfg.saving"));
  try {
    if (section === "project") {
      // 项目配置：入口为空保存 = 移除（后端语义）；模块入口原样写入
      await invoke("set_project_run", { workspaceRoot: app.workspaceRoot, config });
      toast(
        entryTarget
          ? t("run.cfg.savedProject", { cmd: entryKind === "module" ? `python -m ${entryTarget}` : entryTarget })
          : t("run.cfg.removedProject"),
        "success",
      );
    } else {
      // 脚本配置：以文件路径为键（entry.target 由后端按 run_config_key 解析覆盖）
      await invoke("set_run_config", { workspaceRoot: app.workspaceRoot, scriptPath: entryTarget, config });
      toast(t("run.cfg.savedScript", { name: basename(entryTarget) }), "success");
    }
    setBusy(saveBtn, false);
  } catch (e) {
    setBusy(saveBtn, false);
    toastFail(t("run.cfg.failSave"), e);
    appendOutputLine(outputEl, t("run.cfg.saveFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink);
  }
}

// ---------- 接线 ----------

/** 运行配置面板 DOM 接线（main 的 init 调用） */
export function wireRunConfigPanel(): void {
  // 语言切换时若面板打开则重绘分区指示与目标标签；输入区在下次 loadSection 时刷新
  onLocaleChange(() => {
    if (!runConfigModalEl.classList.contains("hidden")) {
      renderSections();
      syncEntryTargetLabel();
    }
  });

  $btn("run-config-close").addEventListener("click", closeRunConfig);
  $btn("run-config-cancel").addEventListener("click", closeRunConfig);
  $btn("run-config-save").addEventListener("click", () => void saveRunConfig());
  runConfigSecScriptBtn.addEventListener("click", () => void switchSection("script"));
  runConfigSecProjectBtn.addEventListener("click", () => void switchSection("project"));
  runConfigEntryKindEl.addEventListener("change", syncEntryTargetLabel);
  // P1-F：输入即清除字段错误（错误是「上次校验」的状态，用户已在修正）
  runConfigTargetInputEl.addEventListener("input", clearFieldError);
  runConfigArgsEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void saveRunConfig();
  });
  runConfigEnvFilesAddEl.addEventListener("click", () => void addEnvFile());
  // 三个组合框：解释器 / 工作目录 / 脚本路径（输入即推荐 + 末尾「浏览…」系统对话框兜底）
  interpreterCombo = createCombobox(runConfigInterpreterEl, runConfigInterpreterDropEl, {
    provide: provideInterpreterCandidates,
    tail: () => [{ label: t("run.cfg.browseInterpreter"), action: () => void browseInterpreter() }],
  });
  cwdCombo = createCombobox(runConfigCwdEl, runConfigCwdDropEl, {
    provide: provideCwdCandidates,
    tail: () => [{ label: t("run.cfg.browseDir"), action: () => void browseCwd() }],
    emptyText: t("run.cfg.noDirMatch"),
  });
  targetCombo = createCombobox(runConfigTargetInputEl, runConfigTargetDropEl, {
    provide: provideScriptCandidates,
    tail: () => [{ label: t("run.cfg.browseFile"), action: () => void browseTargetScript() }],
    emptyText: t("run.cfg.noPyMatch"),
  });
}
