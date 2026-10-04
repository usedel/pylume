// 新建项目域（TD-14 拆分，原 main.ts 的「新建项目」段）：项目创建面板
// （名称 / 位置 / git / 环境类型 / Python 版本）与 create_project 落盘流程。
// openWorkspace / openFile 经 wireNewProject 注入——避免与 main 循环依赖（terminal.ts 先例）。

import { invoke } from "@tauri-apps/api/core";
import { $, $btn, lazyEl, outputEl } from "./state";
import { joinPath, parentDirOf, setBusy, errMsg } from "./util";
import { t } from "./i18n"; // 第九批 i18n：新建项目域动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { appendOutputLine } from "./output";
import { gotoFromLink } from "./tracebackLink";
import { hideEl, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { openAlert } from "./dialog";
import { toast, toastFail } from "./toast";
import { refreshInterpreterStatus, type CreateVenvResult, type PythonVersionOption } from "./envPanel";
import { resetCloneForm, cancelCloneInspect, ensureCloneTabRendered } from "./cloneRepository";

interface CreateProjectResult {
  path: string;
  git_ok: boolean;
  git_message: string;
  /** pyproject.toml 生成说明（uv 官方脚手架 or 模板回退，P2 建议 1） */
  pyproject_note: string;
}

// ---------- 域内 DOM ----------
// P2-6（2026-09-29 review）：顶层快照改惰性（铁律 1，测试环境可 import）。

const newProjectModalEl = lazyEl("new-project-modal");
const newProjectNameEl = lazyEl<HTMLInputElement>("new-project-name");
const newProjectLocationEl = lazyEl<HTMLInputElement>("new-project-location");
const newProjectTypeEl = lazyEl<HTMLSelectElement>("new-project-type");
const newProjectGitEl = lazyEl<HTMLInputElement>("new-project-git");
const newProjectEnvTypeEl = lazyEl<HTMLSelectElement>("new-project-env-type");
const newProjectVersionEl = lazyEl<HTMLSelectElement>("new-project-version");
const newProjectVersionRowEl = lazyEl("new-project-version-row");
const newProjectPreviewEl = lazyEl("new-project-preview");

/** UI-05：模态焦点陷阱解除句柄，关闭时置 null */
let releaseNewProjectFocus: (() => void) | null = null;
/** tech-debt #18：Esc 关闭新建项目面板（document 级，open 时挂、close 时移除）。
 *  守卫：前台有更上层对话框（.modal 显隐约定）时 Esc 归对话框，防连带关闭丢失未保存输入
 * （与 envPanel.onEnvKeydown / bookmarks 同款守卫） */
function onNewProjectKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (document.querySelectorAll(".modal:not(.hidden)").length > 1) return;
  closeNewProjectPanel();
}
/** main 注入的工作区切换 / 文件打开（wireNewProject） */
let openWorkspaceFn: ((root: string) => Promise<void>) | null = null;
let openFileFn: ((path: string, revealLine?: number) => Promise<void>) | null = null;

// ---------- 面板 ----------

/** F9：项目类型元数据（纯函数，可单测）。preview 文案与安装 spec 共用同一实现，防漂移。
 *  未知值一律回退 script（与 Rust create_project 的回退口径一致）。 */
export interface ProjectTypeMeta {
  type: "script" | "fastapi";
  /** 下拉/预览用的展示名 */
  label: string;
  /** 依赖声明（pyproject dependencies + uv add spec）；script 为空 */
  deps: string[];
}

const PROJECT_TYPES: Record<"script" | "fastapi", { label: string; deps: string[] }> = {
  script: { label: t("newproject.type.script"), deps: [] },
  fastapi: { label: t("newproject.type.fastapi"), deps: ["fastapi", "uvicorn"] },
};

export function projectTypeMeta(type: string): ProjectTypeMeta {
  const hit = (PROJECT_TYPES as Record<string, { label: string; deps: string[] } | undefined>)[type];
  if (hit && type !== "script") {
    return { type: "fastapi", label: hit.label, deps: hit.deps.slice() };
  }
  return { type: "script", label: PROJECT_TYPES.script.label, deps: [] };
}

/** 拼接父目录 + 项目名（沿用 joinPath 的分隔符规则） */
function projectTargetPath(): string {
  const parent = newProjectLocationEl.value.trim().replace(/[\\/]+$/, "");
  const name = newProjectNameEl.value.trim();
  if (!parent || !name) return "";
  return joinPath(parent, name);
}

/** 更新「将创建于」预览行（F9：非 script 类型追加入口 + 依赖说明） */
function updateNewProjectPreview(): void {
  const target = projectTargetPath();
  if (!target) {
    newProjectPreviewEl.textContent = "";
    return;
  }
  const meta = projectTypeMeta(newProjectTypeEl.value);
  const suffix =
    meta.type === "script" ? "" : t("newproject.previewSuffix", { label: meta.label, deps: meta.deps.join(" / ") });
  newProjectPreviewEl.textContent = t("newproject.previewPath", { target: target, suffix: suffix });
}

/** 打开新建项目面板（位置默认取最近工作区的父目录，便于就近创建）。
 *  迭代 6：默认显示「本地创建」tab。 */
export async function openNewProjectPanel(): Promise<void> {
  switchNewProjectTab("local");
  newProjectNameEl.value = "";
  newProjectEnvTypeEl.value = "venv";
  newProjectTypeEl.value = "script"; // F9：类型复位（与 venv 复位同口径——不残留上次选择）
  if (!newProjectLocationEl.value.trim()) {
    let recents: string[] = [];
    try {
      recents = await invoke<string[]>("get_recent_workspaces");
    } catch { /* 忽略 */ }
    const parent = recents.length > 0 ? parentDirOf(recents[0]) : "";
    newProjectLocationEl.value = parent;
  }
  updateNewProjectPreview();
  updateNewProjectEnvFields();
  void populateNewProjectVersions();
  showEl(newProjectModalEl);
  document.addEventListener("keydown", onNewProjectKeydown); // tech-debt #18：Esc 关闭
  releaseNewProjectFocus?.();
  releaseNewProjectFocus = trapFocus(newProjectModalEl);
  newProjectNameEl.focus();
}

function closeNewProjectPanel(): void {
  document.removeEventListener("keydown", onNewProjectKeydown); // tech-debt #18
  releaseNewProjectFocus?.();
  releaseNewProjectFocus = null;
  hideEl(newProjectModalEl);
  resetCloneForm();
}

/** 切换新建项目面板 tab（local / clone）。 */
function switchNewProjectTab(tab: "local" | "clone"): void {
  document.querySelectorAll(".new-project-tab").forEach((btn) => {
    const isActive = (btn as HTMLElement).dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    (btn as HTMLButtonElement).ariaSelected = String(isActive);
  });
  const localContent = document.getElementById("new-project-local");
  const cloneContent = document.getElementById("new-project-clone");
  localContent?.classList.toggle("hidden", tab !== "local");
  cloneContent?.classList.toggle("hidden", tab !== "clone");
  // 迭代 6：clone tab 有自己的「克隆」提交按钮——隐藏 local 的「创建」，避免误点与视觉拥挤
  document.getElementById("new-project-create")?.classList.toggle("hidden", tab === "clone");
  // 迭代 6：clone tab 内容区为动态构建——切入时确保已渲染；切走时取消进行中的主分支预览
  if (tab === "clone") ensureCloneTabRendered();
  else cancelCloneInspect();
}

/** 根据环境类型显隐版本/位置行（仅 venv 需要） */
function updateNewProjectEnvFields(): void {
  const isVenv = newProjectEnvTypeEl.value === "venv";
  newProjectVersionRowEl.classList.toggle("hidden", !isVenv);
}

/** 填充 Python 版本下拉（venv 用，含可下载版本标记）。加载期间显示占位。 */
async function populateNewProjectVersions(): Promise<void> {
  newProjectVersionEl.textContent = "";
  const loading = document.createElement("option");
  loading.value = "";
  loading.textContent = t("newproject.loadingVersions");
  newProjectVersionEl.appendChild(loading);
  let versions: PythonVersionOption[] = [];
  try {
    versions = await invoke<PythonVersionOption[]>("list_python_versions");
  } catch (e) {
    console.error("list_python_versions 失败", e);
  }
  newProjectVersionEl.textContent = "";
  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.textContent = t("newproject.versions.default");
  newProjectVersionEl.appendChild(defOpt);
  for (const v of versions) {
    const opt = document.createElement("option");
    opt.value = v.spec;
    opt.textContent = v.installed ? v.version : t("newproject.versions.needDownload", { version: v.version });
    newProjectVersionEl.appendChild(opt);
  }
}

/**
 * 创建项目：磁盘建目录 + main.py + 可选 git；按所选环境类型配置解释器。
 * - venv：按版本/位置创建虚拟环境并选中
 * - system：自动选用已安装解释器
 * - none：不设置（uv run 兜底）
 * 整个流程保持面板可见，按钮以忙碌态指示进度（耗时动作 loading）。
 */
async function createProject(): Promise<void> {
  const name = newProjectNameEl.value.trim();
  const parent = newProjectLocationEl.value.trim();
  if (!name || !parent) {
    newProjectPreviewEl.textContent = t("newproject.needNameAndPath");
    return;
  }
  const wantGit = newProjectGitEl.checked;
  const envType = newProjectEnvTypeEl.value; // venv | system | none
  const version = newProjectVersionEl.value; // venv 时为版本 spec，其余为空
  const meta = projectTypeMeta(newProjectTypeEl.value); // F9：项目类型
  const createBtn = $btn("new-project-create");
  setBusy(createBtn, true, t("newproject.creating"));

  let result: CreateProjectResult;
  try {
    result = await invoke<CreateProjectResult>("create_project", {
      parentDir: parent,
      name,
      gitInit: wantGit,
      pythonVersion: version || null, // P2（建议 1）：所选版本写入 pyproject.toml 的 requires-python
      projectType: meta.type, // F9：script / fastapi
    });
  } catch (e) {
    newProjectPreviewEl.textContent = t("newproject.createFailed", { error: localizeBackendError(errMsg(e)) });
    setBusy(createBtn, false);
    return;
  }
  if (!result.git_ok) {
    appendOutputLine(outputEl, t("newproject.gitInitFailed", { message: result.git_message }), "stderr", gotoFromLink, "env");
    toastFail("git init", result.git_message);
  }
  // P2（建议 1）：回显 pyproject.toml 的生成路径（uv 脚手架 / 模板回退），让“裸目录 uv run 语义不明”可见地收敛
  if (result.pyproject_note) {
    appendOutputLine(outputEl, result.pyproject_note, "stdout", gotoFromLink, "env");
  }
  await openWorkspaceFn?.(result.path);
  await openFileFn?.(joinPath(result.path, "main.py"));

  try {
    if (envType === "venv") {
      appendOutputLine(outputEl, `> uv venv .venv${version ? " --python " + version : ""}  (${result.path})`, "cmd", gotoFromLink, "env");
      setBusy(createBtn, true, t("newproject.creatingEnv"));
      const r = await invoke<CreateVenvResult>("create_venv", { workspaceRoot: result.path, version });
      if (r.output) appendOutputLine(outputEl, r.output, "stdout", gotoFromLink, "env");
      if (r.python) await invoke("set_interpreter", { workspaceRoot: result.path, path: r.python }).catch(console.error);
    } else if (envType === "system") {
      const interp = await invoke<string | null>("pick_default_system_interpreter");
      if (interp) {
        await invoke("set_interpreter", { workspaceRoot: result.path, path: interp }).catch(console.error);
        toast(t("newproject.systemInterpreter", { interp: interp }), "info");
      } else {
        // P1（建议 4）：未检测到解释器时给出可执行引导（长指导走 openAlert 对话框，非输出面板 stderr）
        void openAlert({
          title: t("newproject.noInterpTitle"),
          message:
            // 引导语多段拼装（含 \n\n 不走 apply_ts 映射，避免语言包转义链失真），按段取词
            `${t("newproject.noInterpHead")}\n\n` +
            `${t("newproject.noInterpStep1")}\n` +
            `${t("newproject.noInterpStep2")}\n\n` +
            t("newproject.noInterpFallback"),
          okLabel: t("newproject.gotIt"),
        });
      }
    }
  } catch (e) {
    appendOutputLine(outputEl, t("newproject.envSetupFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "env");
    toastFail(t("newproject.failEnvSetup"), e);
  }

  // F9：依赖安装（best-effort，不阻断）——声明已由 create_project 写入 pyproject.toml，
  // 这里走既有 pip_install（有 pyproject 自动 uv add + 流式输出 + cwd），幂等。
  // 失败 = 操作结果 → toastFail（q3 裁决：用户视线多已在新工作区，仅输出面板 stderr 偏静默）；
  // 成功不加 toast（流式输出 + 面板关闭即完成信号，与 script 路径的克制一致）。
  if (meta.deps.length > 0) {
    const spec = meta.deps.join(" ");
    setBusy(createBtn, true, t("newproject.installingDeps"));
    appendOutputLine(outputEl, `> uv add ${spec}  (${result.path})`, "cmd", gotoFromLink, "env");
    try {
      const code = await invoke<number>("pip_install", {
        workspaceRoot: result.path,
        interpreter: null,
        spec,
      });
      if (code !== 0) {
        const msg = t("newproject.depsExitFailed", { code: code });
        appendOutputLine(outputEl, msg, "stderr", gotoFromLink, "env");
        toastFail(t("newproject.failDeps"), t("newproject.depsExitNote", { code: code }));
      }
    } catch (e) {
      appendOutputLine(
        outputEl,
        t("newproject.depsFailedNonBlocking", { error: localizeBackendError(errMsg(e)) }),
        "stderr",
        gotoFromLink,
        "env",
      );
      toastFail(t("newproject.failDeps"), e);
    }
  }

  closeNewProjectPanel();
  setBusy(createBtn, false);
  await refreshInterpreterStatus();
}

// ---------- 接线 ----------

/** 新建项目面板 DOM 接线（main 的 init 调用）；openWorkspace / openFile 由 main 注入 */
export function wireNewProject(deps: {
  openWorkspace: (root: string) => Promise<void>;
  openFile: (path: string, revealLine?: number) => Promise<void>;
}): void {
  openWorkspaceFn = deps.openWorkspace;
  openFileFn = deps.openFile;
  // 新建项目（文件菜单入口）
  $btn("new-project-close").addEventListener("click", closeNewProjectPanel);
  $btn("new-project-cancel").addEventListener("click", closeNewProjectPanel);
  $btn("new-project-create").addEventListener("click", () => createProject());
  $("new-project-browse").addEventListener("click", async () => {
    const p = await invoke<string | null>("pick_folder");
    if (p) {
      newProjectLocationEl.value = p;
      updateNewProjectPreview();
    }
  });
  newProjectNameEl.addEventListener("input", updateNewProjectPreview);
  newProjectLocationEl.addEventListener("input", updateNewProjectPreview);
  newProjectTypeEl.addEventListener("change", updateNewProjectPreview); // F9：切换类型刷新预览说明
  newProjectEnvTypeEl.addEventListener("change", updateNewProjectEnvFields);
  newProjectNameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createProject();
  });
  newProjectLocationEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createProject();
  });
  // 迭代 6：tab 切换
  document.querySelectorAll(".new-project-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = (btn as HTMLElement).dataset.tab as "local" | "clone";
      if (tab) switchNewProjectTab(tab);
    });
  });
  // tech-debt #18：含可编辑内容，点遮罩不关闭（仅 X / 取消 / Esc 关闭）
}
