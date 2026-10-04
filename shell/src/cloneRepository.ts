// Clone 域（迭代 6 · P3-1）：从远端克隆仓库。
// 设计要点：
// - 域自治，不直接 import main.ts；openWorkspace/openFile 经 wireCloneRepository 注入。
// - 纯函数（detectPlatform / deriveTargetDir）可单测。
// - 流式进度复用 git-op-stdout 事件（与 git.ts 同模式）。
// - 文案全部走 t() 动态取词，语言切换时重建。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { lazyEl } from "./state";
import { joinPath, setBusy, errMsg } from "./util";
import { t, onLocaleChange } from "./i18n";
// import { localizeBackendError } from "./i18n/backendError"; // clone 错误走前端轻量映射（git stderr 为英文）
import { appendOutputLine } from "./output";
import { outputEl } from "./state";
import { gotoFromLink } from "./tracebackLink";
import { toast, toastFail } from "./toast";
import { openConfirm } from "./dialog";

// ---------- 纯函数（可单测） ----------

/** 识别 git 托管平台。 */
export function detectPlatform(url: string): "github" | "gitlab" | "gitee" | "other" {
  const trimmed = url.trim();
  if (!trimmed) return "other";
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "gitlab";
    if (host === "gitee.com" || host.endsWith(".gitee.com")) return "gitee";
  } catch {
    const m = trimmed.match(/^git@([^:]+):/);
    if (m) {
      const host = m[1].toLowerCase();
      if (host === "github.com") return "github";
      if (host === "gitlab.com") return "gitlab";
      if (host === "gitee.com") return "gitee";
    }
  }
  return "other";
}

/** 从 URL 推导默认目标目录名。 */
export function deriveTargetDir(url: string, defaultParent: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").pop() || "";
    return joinPath(defaultParent, last.replace(/\.git$/, ""));
  } catch {
    const m = url.match(/[:/]([^/]+?)(?:\.git)?$/);
    return joinPath(defaultParent, m?.[1] || "repo");
  }
}

/** scheme 白名单校验。 */
function isValidScheme(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("git@")) return true;
  try {
    const u = new URL(trimmed);
    return ["https:", "http:", "ssh:", "git:", "file:"].includes(u.protocol);
  } catch {
    return false;
  }
}

// ---------- 状态 ----------

interface CloneState {
  url: string;
  targetDir: string;
  depth1: boolean;
  inspecting: boolean;
  defaultBranch: string | null;
  busy: boolean;
  progressLines: string[];
}

let cloneState: CloneState = {
  url: "",
  targetDir: "",
  depth1: false,
  inspecting: false,
  defaultBranch: null,
  busy: false,
  progressLines: [],
};

let inspectDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let inspectCancelToken = 0;
let unlistenProgress: (() => void) | null = null;

let openWorkspaceFn: ((root: string) => Promise<void>) | null = null;
let openFileFn: ((path: string, revealLine?: number) => Promise<void>) | null = null;
let openPanelFn: (() => Promise<void> | void) | null = null;

// ---------- DOM 引用 ----------

const cloneContainerEl = lazyEl("new-project-clone");

// 动态创建的 DOM 元素（render 后缓存）
let els: {
  urlLabel: HTMLElement | null;
  urlInput: HTMLInputElement | null;
  targetLabel: HTMLElement | null;
  targetInput: HTMLInputElement | null;
  depthCheck: HTMLInputElement | null;
  depthSpan: HTMLElement | null;
  branchPrefix: HTMLElement | null;
  presetBtns: HTMLElement[];
  browseBtn: HTMLButtonElement | null;
  submitBtn: HTMLButtonElement | null;
  progressWrap: HTMLElement | null;
  progressText: HTMLElement | null;
  progressFill: HTMLElement | null;
  cancelBtn: HTMLButtonElement | null;
  branchPreview: HTMLElement | null;
  branchName: HTMLElement | null;
  platformHint: HTMLElement | null;
} = {
  urlLabel: null,
  urlInput: null,
  targetLabel: null,
  targetInput: null,
  depthCheck: null,
  depthSpan: null,
  branchPrefix: null,
  presetBtns: [],
  browseBtn: null,
  submitBtn: null,
  progressWrap: null,
  progressText: null,
  progressFill: null,
  cancelBtn: null,
  branchPreview: null,
  branchName: null,
  platformHint: null,
};

// ---------- 渲染 ----------

/** 首次显示 clone tab 时构建 DOM（幂等：已构建则跳过）。 */
function ensureRenderCloneTab(): void {
  if (cloneContainerEl.children.length > 0) return;

  const c = document.createElement("div");
  c.className = "clone-form";

  // ① URL
  const urlRow = document.createElement("div");
  urlRow.className = "settings-row clone-url-row";
  const urlLabel = document.createElement("label");
  urlLabel.textContent = t("cloneRepository.url.label");
  const urlInput = document.createElement("input");
  urlInput.id = "clone-url";
  urlInput.type = "text";
  urlInput.autocomplete = "off";
  urlInput.placeholder = "https://github.com/owner/repo.git";
  urlInput.spellcheck = false;
  const presets = document.createElement("div");
  presets.className = "clone-presets";
  (["github", "gitlab", "gitee"] as const).forEach((platform) => {
    const btn = document.createElement("button");
    btn.className = "btn btn--ghost btn--icon clone-preset";
    btn.dataset.platform = platform;
    btn.title = t(`cloneRepository.platform.${platform}`);
    const icon = document.createElement("i");
    icon.className = `codicon codicon-${platform === "gitee" ? "cloud" : platform}`;
    icon.setAttribute("aria-hidden", "true");
    btn.appendChild(icon);
    presets.appendChild(btn);
  });
  urlRow.appendChild(urlLabel);
  // 控件行（input + 平台预设按钮同排；label 单独一行，避免 160px 标签列挤压输入框）
  const urlLine = document.createElement("div");
  urlLine.className = "clone-line";
  urlLine.appendChild(urlInput);
  urlLine.appendChild(presets);
  urlRow.appendChild(urlLine);
  c.appendChild(urlRow);

  const platformHint = document.createElement("div");
  platformHint.className = "clone-hint hidden";
  c.appendChild(platformHint);

  // ② 目标路径
  const targetRow = document.createElement("div");
  targetRow.className = "settings-row clone-target-row";
  const targetLabel = document.createElement("label");
  targetLabel.textContent = t("cloneRepository.target.label");
  const targetInput = document.createElement("input");
  targetInput.id = "clone-target";
  targetInput.type = "text";
  targetInput.autocomplete = "off";
  targetInput.spellcheck = false;
  const browseBtn = document.createElement("button");
  browseBtn.className = "btn";
  browseBtn.id = "clone-browse";
  browseBtn.textContent = t("cloneRepository.target.browse");
  targetRow.appendChild(targetLabel);
  const targetLine = document.createElement("div");
  targetLine.className = "clone-line";
  targetLine.appendChild(targetInput);
  targetLine.appendChild(browseBtn);
  targetRow.appendChild(targetLine);
  c.appendChild(targetRow);

  // ③ 浅克隆
  const depthRow = document.createElement("label");
  depthRow.className = "settings-row clone-option";
  const depthCheck = document.createElement("input");
  depthCheck.type = "checkbox";
  depthCheck.id = "clone-depth1";
  const depthSpan = document.createElement("span");
  depthSpan.textContent = t("cloneRepository.depth.checkbox");
  depthRow.appendChild(depthCheck);
  depthRow.appendChild(depthSpan);
  c.appendChild(depthRow);

  // ④ 主分支预览
  const branchPreview = document.createElement("div");
  branchPreview.className = "clone-hint hidden";
  branchPreview.id = "clone-branch-preview";
  const branchPrefix = document.createElement("span");
  branchPrefix.textContent = t("cloneRepository.detectedBranch");
  const branchName = document.createElement("span");
  branchName.id = "clone-branch-name";
  branchPreview.appendChild(branchPrefix);
  branchPreview.appendChild(branchName);
  c.appendChild(branchPreview);

  // ⑤ 提交按钮
  const submitBtn = document.createElement("button");
  submitBtn.className = "btn btn--primary";
  submitBtn.id = "clone-submit";
  submitBtn.textContent = t("cloneRepository.submit");
  c.appendChild(submitBtn);

  // ⑥ 进度区
  const progressWrap = document.createElement("div");
  progressWrap.className = "clone-progress hidden";
  progressWrap.id = "clone-progress";
  const progressBar = document.createElement("div");
  progressBar.className = "clone-progress-bar";
  const progressFill = document.createElement("div");
  progressFill.className = "clone-progress-fill";
  progressFill.id = "clone-progress-fill";
  progressBar.appendChild(progressFill);
  const progressText = document.createElement("div");
  progressText.className = "clone-progress-text";
  progressText.id = "clone-progress-text";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--ghost";
  cancelBtn.id = "clone-cancel";
  cancelBtn.textContent = t("cloneRepository.cancel");
  progressWrap.appendChild(progressBar);
  progressWrap.appendChild(progressText);
  progressWrap.appendChild(cancelBtn);
  c.appendChild(progressWrap);

  cloneContainerEl.appendChild(c);

  // 缓存引用
  els = {
    urlLabel,
    urlInput,
    targetLabel,
    targetInput,
    depthCheck,
    depthSpan,
    branchPrefix,
    presetBtns: Array.from(presets.querySelectorAll(".clone-preset")),
    browseBtn,
    submitBtn,
    progressWrap,
    progressText,
    progressFill,
    cancelBtn,
    branchPreview,
    branchName,
    platformHint,
  };

  // 事件接线
  urlInput.addEventListener("input", onUrlInput);
  urlInput.addEventListener("blur", onUrlBlur);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSubmit();
  });
  targetInput.addEventListener("input", onTargetInput);
  targetInput.addEventListener("blur", onTargetBlur);
  targetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSubmit();
  });
  depthCheck.addEventListener("change", () => {
    cloneState.depth1 = depthCheck.checked;
  });
  submitBtn.addEventListener("click", onSubmit);
  cancelBtn.addEventListener("click", onCancel);
  browseBtn.addEventListener("click", onBrowse);
  presets.querySelectorAll(".clone-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const platform = (btn as HTMLElement).dataset.platform;
      const prefix =
        platform === "github"
          ? "https://github.com/"
          : platform === "gitlab"
            ? "https://gitlab.com/"
            : "https://gitee.com/";
      urlInput.value = prefix;
      urlInput.focus();
      // 光标移到末尾
      urlInput.setSelectionRange(prefix.length, prefix.length);
      onUrlInput();
    });
  });

  // 语言切换：重绘本域全部静态文案（不重建 DOM，保留用户输入）
  onLocaleChange(applyCloneTexts);
}

/** 重绘 clone tab 静态文案（onLocaleChange 回调；busy 态不动提交按钮文案）。 */
function applyCloneTexts(): void {
  if (els.urlLabel) els.urlLabel.textContent = t("cloneRepository.url.label");
  if (els.urlInput) els.urlInput.placeholder = "https://github.com/owner/repo.git";
  for (const btn of els.presetBtns) {
    const platform = (btn.dataset.platform || "other") as "github" | "gitlab" | "gitee" | "other";
    btn.title = t(`cloneRepository.platform.${platform}`);
  }
  if (els.targetLabel) els.targetLabel.textContent = t("cloneRepository.target.label");
  if (els.browseBtn) els.browseBtn.textContent = t("cloneRepository.target.browse");
  if (els.depthSpan) els.depthSpan.textContent = t("cloneRepository.depth.checkbox");
  if (els.branchPrefix) els.branchPrefix.textContent = t("cloneRepository.detectedBranch");
  if (els.cancelBtn) els.cancelBtn.textContent = t("cloneRepository.cancel");
  if (!cloneState.busy && els.submitBtn) els.submitBtn.textContent = t("cloneRepository.submit");
}

/** clone busy 期间锁定新建项目面板 tab 切换（防止克隆中误切 local 创建）。 */
function setCloneTabLock(lock: boolean): void {
  document.querySelectorAll<HTMLButtonElement>(".new-project-tab").forEach((btn) => {
    btn.disabled = lock;
    btn.title = lock ? t("cloneRepository.submitting") : "";
  });
}

// ---------- 事件处理 ----------

function onUrlInput(): void {
  const val = els.urlInput?.value ?? "";
  cloneState.url = val;

  // 平台识别
  const platform = detectPlatform(val);
  if (els.platformHint) {
    if (platform !== "other" && val.trim()) {
      els.platformHint.textContent = t(`cloneRepository.platform.${platform}`);
      els.platformHint.classList.remove("hidden");
    } else {
      els.platformHint.classList.add("hidden");
    }
  }

  // 校验样式
  updateValidationStyle(els.urlInput, val.trim() !== "" && isValidScheme(val));

  // 防抖预览主分支
  if (inspectDebounceTimer) clearTimeout(inspectDebounceTimer);
  hideBranchPreview();
  if (val.trim() && isValidScheme(val)) {
    inspectDebounceTimer = setTimeout(() => {
      void inspectDefaultBranch(val);
    }, 300);
  }

  updateSubmitState();
}

function onUrlBlur(): void {
  const val = els.urlInput?.value ?? "";
  if (val.trim() && !isValidScheme(val)) {
    updateValidationStyle(els.urlInput, false);
  }
}

function onTargetInput(): void {
  cloneState.targetDir = els.targetInput?.value ?? "";
  updateSubmitState();
}

function onTargetBlur(): void {
  const val = els.targetInput?.value ?? "";
  if (!val.trim() && cloneState.url.trim()) {
    // 自动推导
    const parent = getDefaultParentDir();
    const derived = deriveTargetDir(cloneState.url, parent);
    if (els.targetInput) els.targetInput.value = derived;
    cloneState.targetDir = derived;
  }
  updateSubmitState();
}

function updateValidationStyle(el: HTMLInputElement | null, valid: boolean): void {
  if (!el) return;
  el.classList.toggle("input-error", !valid);
}

function getDefaultParentDir(): string {
  const loc = document.getElementById("new-project-location") as HTMLInputElement | null;
  return loc?.value.trim() || "";
}

function updateSubmitState(): void {
  if (!els.submitBtn) return;
  const valid =
    cloneState.url.trim() !== "" &&
    isValidScheme(cloneState.url) &&
    cloneState.targetDir.trim() !== "";
  els.submitBtn.disabled = !valid || cloneState.busy;
}

async function onBrowse(): Promise<void> {
  const path = await invoke<string | null>("pick_folder");
  if (path && els.targetInput) {
    els.targetInput.value = path;
    cloneState.targetDir = path;
    updateSubmitState();
  }
}

async function onSubmit(): Promise<void> {
  if (cloneState.busy) return;
  const url = cloneState.url.trim();
  const target = cloneState.targetDir.trim();
  if (!url || !isValidScheme(url) || !target) return;
  await doClone(url, target);
}

async function doClone(url: string, target: string): Promise<void> {
  cloneState.busy = true;
  cloneState.progressLines = [];
  setCloneTabLock(true);
  updateSubmitState();
  setBusy(els.submitBtn!, true, t("cloneRepository.submitting"));

  els.progressWrap?.classList.remove("hidden");
  if (els.progressText) els.progressText.textContent = t("cloneRepository.progress.default");
  if (els.progressFill) els.progressFill.style.width = "0%";

  // 订阅流式进度
  unlistenProgress = await (await getCurrentWindow()).listen<{ op: string; data: string }>(
    "git-op-stdout",
    (e) => {
      if (e.payload.op !== "clone") return;
      const line = e.payload.data;
      cloneState.progressLines.push(line);
      if (cloneState.progressLines.length > 200) cloneState.progressLines.shift();
      if (els.progressText) {
        const last = line.trim();
        if (last) els.progressText.textContent = last;
      }
      const m = line.match(/(\d+)%/);
      if (m && els.progressFill) {
        els.progressFill.style.width = `${m[1]}%`;
      }
      appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
    }
  );

  try {
    const result = await invoke<string>("git_clone", {
      url,
      targetDir: target,
      depth: cloneState.depth1 ? 1 : null,
      branch: cloneState.defaultBranch || null,
    });
    toast(t("cloneRepository.success", { path: target }), "success");
    appendOutputLine(outputEl, result, "stdout", gotoFromLink, "git");
    await finishClone(target);
  } catch (e) {
    const raw = errMsg(e);
    const msg = localizeCloneError(raw);
    // 目标目录已存在 → 提供自动子目录选项
    if (raw.includes("already exists and is not an empty directory")) {
      const sub = deriveTargetDir(cloneState.url, target);
      const go = await openConfirm({
        title: t("cloneRepository.conflict.title"),
        message: t("cloneRepository.conflict.message", { path: target }) + "\n\n" + t("cloneRepository.conflict.subdirHint", { sub }),
        okLabel: t("cloneRepository.conflict.subdir"),
        cancelLabel: t("cloneRepository.conflict.change"),
      });
      if (go) {
        if (els.targetInput) els.targetInput.value = sub;
        cloneState.targetDir = sub;
        updateSubmitState();
        await doClone(cloneState.url, sub);
        return; // 避免走 finally 中的通用复位（doClone 自己会管理）
      }
      // 用户选「换个路径」→ focus 目标输入框
      els.targetInput?.focus();
    } else if (raw.includes("已取消") || /cancel{1,2}ed/i.test(raw)) {
      // 用户取消（Rust 侧 git_cancel_op 返回「已取消」）：info 级提示，不弹失败
      toast(t("cloneRepository.cancelled"), "info");
    } else {
      toastFail(t("cloneRepository.submit"), msg);
    }
    appendOutputLine(outputEl, msg, "stderr", gotoFromLink, "git");
  } finally {
    cloneState.busy = false;
    setCloneTabLock(false);
    unlistenProgress?.();
    unlistenProgress = null;
    setBusy(els.submitBtn!, false);
    updateSubmitState();
    els.progressWrap?.classList.add("hidden");
    if (els.progressFill) els.progressFill.style.width = "0%";
  }
}

async function onCancel(): Promise<void> {
  if (!cloneState.busy) return;
  await invoke("git_cancel_op", { op: "clone" });
  if (els.progressText) els.progressText.textContent = t("cloneRepository.cancelling");
}

// ---------- 主分支预览 ----------

async function inspectDefaultBranch(url: string): Promise<void> {
  const token = ++inspectCancelToken;
  cloneState.inspecting = true;
  if (els.branchPreview) {
    els.branchPreview.classList.remove("hidden");
    if (els.branchName) els.branchName.textContent = "…";
  }

  try {
    const branch = await invoke<string>("git_default_branch", { url });
    if (token !== inspectCancelToken) return; // 乱序丢弃
    cloneState.defaultBranch = branch === "HEAD" ? null : branch;
    if (els.branchName) {
      els.branchName.textContent = branch === "HEAD" ? "default" : branch;
    }
  } catch {
    if (token !== inspectCancelToken) return;
    cloneState.defaultBranch = null;
    if (els.branchPreview) els.branchPreview.classList.add("hidden");
  } finally {
    cloneState.inspecting = false;
  }
}

function hideBranchPreview(): void {
  els.branchPreview?.classList.add("hidden");
  cloneState.defaultBranch = null;
}

// ---------- 错误本地化 ----------

function localizeCloneError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes("authentication failed") || r.includes("could not read username") || r.includes("terminal prompts disabled")) {
    return t("cloneRepository.err.authFailed");
  }
  if (r.includes("could not resolve host")) {
    return t("cloneRepository.err.resolveHost");
  }
  if (r.includes("repository not found")) {
    return t("cloneRepository.err.repoNotFound");
  }
  if (r.includes("already exists and is not an empty directory")) {
    return t("cloneRepository.err.notEmpty");
  }
  return raw;
}

// ---------- 冲突处理 ----------
// 已内联到 doClone 的 catch 分支：目录已存在时弹 openConfirm 提供自动子目录选项。

// ---------- 完成后打开 ----------

async function finishClone(target: string): Promise<void> {
  // 关闭新建项目面板
  const closeBtn = document.getElementById("new-project-close") as HTMLButtonElement | null;
  closeBtn?.click();

  await openWorkspaceFn?.(target);

  // 尝试打开 README.md
  const readmePath = joinPath(target, "README.md");
  try {
    await invoke("read_file", { path: readmePath });
    await openFileFn?.(readmePath);
    return;
  } catch {
    /* 无 README，继续找 .py */
  }

  // 列出文件找第一个 .py
  try {
    const files = await invoke<string[]>("list_workspace_files", { root: target });
    const firstPy = files.find((f) => f.endsWith(".py"));
    if (firstPy) {
      await openFileFn?.(joinPath(target, firstPy));
    }
  } catch {
    /* 静默放弃 */
  }
}

// ---------- 公开 API ----------

/** 激活 clone tab 并打开新建项目面板（供命令面板/菜单调用）。 */
export function openCloneTab(): void {
  ensureRenderCloneTab();
  void Promise.resolve(openPanelFn?.()).then(() => {
    // 面板打开后触发 tab 切换（openNewProjectPanel 默认激活 local，此处改切 clone）
    const cloneTabBtn = document.querySelector('.new-project-tab[data-tab="clone"]') as HTMLButtonElement | null;
    if (cloneTabBtn && !cloneTabBtn.disabled) cloneTabBtn.click();
    // focus URL 输入
    setTimeout(() => els.urlInput?.focus(), 50);
  });
}

/** 清空 clone 表单（面板关闭时调用）。 */
export function resetCloneForm(): void {
  cloneState = {
    url: "",
    targetDir: "",
    depth1: false,
    inspecting: false,
    defaultBranch: null,
    busy: false,
    progressLines: [],
  };
  if (els.urlInput) els.urlInput.value = "";
  if (els.targetInput) els.targetInput.value = "";
  if (els.depthCheck) els.depthCheck.checked = false;
  if (els.platformHint) els.platformHint.classList.add("hidden");
  hideBranchPreview();
  if (els.progressWrap) els.progressWrap.classList.add("hidden");
  updateSubmitState();
  setCloneTabLock(false);
  cancelCloneInspect();
}

/** 取消进行中的主分支预览（切走 clone tab / 关面板时调用，防后台空转）。 */
export function cancelCloneInspect(): void {
  if (inspectDebounceTimer) {
    clearTimeout(inspectDebounceTimer);
    inspectDebounceTimer = null;
  }
  inspectCancelToken++;
  cloneState.inspecting = false;
}

/** 确保 clone tab 内容区已构建（newProject.ts 切到 clone tab 时调用）。 */
export function ensureCloneTabRendered(): void {
  ensureRenderCloneTab();
}

/** 接线（main.ts init 调用）。 */
export function wireCloneRepository(deps: {
  openWorkspace: (root: string) => Promise<void>;
  openFile: (path: string, revealLine?: number) => Promise<void>;
  openPanel: () => Promise<void> | void;
}): void {
  openWorkspaceFn = deps.openWorkspace;
  openFileFn = deps.openFile;
  openPanelFn = deps.openPanel;
}
