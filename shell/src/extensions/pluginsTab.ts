// 设置页「插件」tab 渲染域（PR-2，plugin_system_design §9.14 + P0 DX）：
// 目录行（真实路径/复制/打开/重扫/新建插件/作者指南）+ 插件列表（行展开：元数据/权限/工具/操作/日志）。
// 独立模块避免 settingsPanel.ts 膨胀；进入分类时由 switchCategory 触发 renderPluginsTab。
//
// P0 DX（「10 秒正反馈」闭环）：
// - 目录提示 = Rust get_plugins_dir 的真实绝对路径（修掉写死 "~" 的错误提示）；
// - 「新建插件…」：对话框收 id/名称 → scaffold_plugin 落盘模板 → 热重载自动加载；
// - 「作者指南」：?raw 打包的指南 markdown 落盘临时文件 → openFile（.md 自动开预览）。

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { codicon, errMsg } from "../util";
import { localizeBackendError } from "../i18n/backendError";
import { toast } from "../toast";
import { openAlert } from "../dialog";
import { t } from "../i18n"; // 第十五批 i18n：扩展面板动态文案走语言包
import { disablePlugin, enablePlugin, listPluginRecords, reloadPlugin, scanPlugins, type PluginRecord } from "./loader";
// 指南源（仓库 docs/，经 ?raw 打包进产物）：src/extensions/ → 仓库根是三级上溯
import guideRaw from "../../../docs/devtools_plugin_guide.md?raw";

/** 指南落盘路径（数据根 docs 子目录；main.ts 注入 openFile 打开） */
let openGuideFile: ((path: string) => Promise<unknown>) | null = null;

/** 注入「打开文件」能力（main.ts；避免反向依赖） */
export function setPluginsTabHandlers(h: { openFile: (path: string) => Promise<unknown> }): void {
  openGuideFile = h.openFile;
}

/** 写文件到数据根 docs/（复用 fs write_file；路径 = <data_root>/docs/<name>） */
async function writeDataDoc(name: string, content: string): Promise<string> {
  const path = await invoke<string>("get_data_doc_path", { name });
  await invoke("write_file", { path, content });
  return path;
}

/** 渲染整个插件 tab（进入分类 / 操作后刷新共用） */
export async function renderPluginsTab(): Promise<void> {
  const root = document.getElementById("plugins-panel");
  if (!root) return;
  root.textContent = "";

  // ---- 目录操作行（真实路径 + 复制 + 打开 + 重扫） ----
  let dirPath = "";
  try {
    dirPath = await invoke<string>("get_plugins_dir");
  } catch {
    dirPath = t("ext.unknownDir");
  }
  const dirRow = document.createElement("div");
  dirRow.className = "plugins-dir-row";
  const dirLabel = document.createElement("span");
  dirLabel.className = "plugins-dir-label";
  dirLabel.textContent = t("ext.dirLabel", { dir: dirPath });
  dirLabel.title = dirPath;
  const copyDirBtn = document.createElement("button");
  copyDirBtn.className = "btn btn--sm";
  copyDirBtn.appendChild(codicon("copy"));
  copyDirBtn.append(t("ext.copyPath"));
  copyDirBtn.addEventListener("click", () => {
    void invoke("copy_to_clipboard", { text: dirPath }).then(() => toast(t("ext.pathCopied"), "success"));
  });
  const openDirBtn = document.createElement("button");
  openDirBtn.className = "btn btn--sm";
  openDirBtn.appendChild(codicon("folder-opened"));
  openDirBtn.append(t("ext.openDir"));
  openDirBtn.addEventListener("click", () => {
    void invoke("reveal_plugins_dir").catch((e) => toast(t("ext.openDirFailed", { error: localizeBackendError(errMsg(e)) }), "error"));
  });
  const rescanBtn = document.createElement("button");
  rescanBtn.className = "btn btn--sm";
  rescanBtn.appendChild(codicon("refresh"));
  rescanBtn.append(t("ext.rescan"));
  rescanBtn.addEventListener("click", () => {
    void scanPlugins().then(() => {
      renderPluginsTab();
      toast(t("ext.scanDone"), "success");
    });
  });
  dirRow.append(dirLabel, copyDirBtn, openDirBtn, rescanBtn);
  root.appendChild(dirRow);

  // ---- DX 行：新建 / 导入 / 作者指南 ----
  const dxRow = document.createElement("div");
  dxRow.className = "plugins-dx-row";
  const newBtn = document.createElement("button");
  newBtn.className = "btn btn--primary btn--sm";
  newBtn.appendChild(codicon("add"));
  newBtn.append(t("ext.newPlugin"));
  newBtn.addEventListener("click", () => void showScaffoldDialog());
  const importBtn = document.createElement("button");
  importBtn.className = "btn btn--sm";
  importBtn.appendChild(codicon("cloud-download"));
  importBtn.append(t("ext.importPluginMenu"));
  importBtn.addEventListener("click", () => void importPluginFromZip());
  const guideBtn = document.createElement("button");
  guideBtn.className = "btn btn--sm";
  guideBtn.appendChild(codicon("book"));
  guideBtn.append(t("ext.authorGuide"));
  guideBtn.addEventListener("click", () => void openGuide());
  dxRow.append(newBtn, importBtn, guideBtn);
  root.appendChild(dxRow);

  // ---- 插件列表 ----
  const records = listPluginRecords();
  const list = document.createElement("div");
  list.className = "plugins-list";
  if (records.length === 0) {
    const empty = document.createElement("div");
    empty.className = "plugins-empty";
    empty.textContent = t("ext.empty");
    list.appendChild(empty);
  } else {
    for (const rec of records) list.appendChild(renderPluginRow(rec));
  }
  root.appendChild(list);
}

/** 打开作者指南（落盘数据根 docs → openFile → .md 自动开预览）；MB-13：帮助菜单「作者指南」同入口复用 */
export async function openGuide(): Promise<void> {
  if (!openGuideFile) return;
  try {
    const path = await writeDataDoc("devtools_plugin_guide.md", guideRaw);
    await openGuideFile(path);
  } catch (e) {
    toast(t("ext.guideFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }), "error");
  }
}

/** 导入插件 zip（P2 分发）：选文件 → Rust 解包校验落盘 → 重扫 */
async function importPluginFromZip(): Promise<void> {
  const picked = await openDialog({
    title: t("ext.importZipTitle"),
    multiple: false,
    directory: false,
    filters: [{ name: t("ext.pluginPkgFilter"), extensions: ["zip"] }],
  });
  if (typeof picked !== "string" || !picked) return; // 取消
  try {
    await invoke<string>("import_plugin", { zipPath: picked });
    await scanPlugins();
    renderPluginsTab();
    toast(t("ext.importSuccess"), "success");
  } catch (e) {
    void openAlert({ title: t("ext.importTitle"), message: t("ext.importFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }) });
  }
}

/** 导出插件为 zip（P2 分发）：行内「导出」按钮调用 */
async function exportPluginZip(rec: PluginRecord): Promise<void> {
  if (rec.source !== "global") {
    toast(t("ext.builtinNoExport"), "info");
    return;
  }
  try {
    const defaultName = await invoke<string>("plugin_export_filename", { pluginDir: rec.dir });
    const target = await saveDialog({
      title: t("ext.exportTitle"),
      defaultPath: defaultName,
      filters: [{ name: t("ext.pluginPkgFilter"), extensions: ["zip"] }],
    });
    if (typeof target !== "string" || !target) return; // 取消
    await invoke<string>("export_plugin", { pluginDir: rec.dir, savePath: target });
    toast(t("ext.exportedTo", { target: target }), "success");
  } catch (e) {
    void openAlert({ title: t("ext.exportTitle"), message: t("ext.exportFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }) });
  }
}

/** 新建插件对话框（P1：单表单——id + 名称 + 模板单选一次填完） → scaffold_plugin → 加载 */
async function showScaffoldDialog(): Promise<void> {
  const form = await promptScaffoldForm();
  if (form === null) return;
  try {
    await invoke<string>("scaffold_plugin", { id: form.id, name: form.name, template: form.template });
    await scanPlugins(); // 目录监听可能因创建时序错过首事件，主动扫一次保证「点了就有」
    renderPluginsTab();
    const next =
      form.template === "inline"
        ? t("ext.nextInline")
        : t("ext.nextPanel");
    toast(t("ext.scaffoldCreated", { next: next }), "success");
  } catch (e) {
    void openAlert({ title: t("ext.scaffoldTitle"), message: t("ext.createFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }) });
  }
}

/** 脚手架表单（id + 名称 + 模板 radioGroup；返回 null = 取消） */
function promptScaffoldForm(): Promise<{ id: string; name: string; template: "panel" | "inline" | "blank" } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    const card = document.createElement("div");
    card.className = "modal-card scaffold-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", t("ext.newCardAria"));

    const title = document.createElement("div");
    title.className = "scaffold-title";
    title.textContent = t("ext.newCardAria");

    const idLabel = document.createElement("label");
    idLabel.className = "scaffold-field-label";
    idLabel.htmlFor = "scaffold-id";
    idLabel.textContent = t("ext.fieldId");
    const idInput = document.createElement("input");
    idInput.id = "scaffold-id";
    idInput.type = "text";
    idInput.placeholder = t("ext.idPlaceholder");
    idInput.autocomplete = "off";
    idInput.spellcheck = false;

    const nameLabel = document.createElement("label");
    nameLabel.className = "scaffold-field-label";
    nameLabel.htmlFor = "scaffold-name";
    nameLabel.textContent = t("ext.fieldName");
    const nameInput = document.createElement("input");
    nameInput.id = "scaffold-name";
    nameInput.type = "text";
    nameInput.placeholder = t("ext.namePlaceholder");
    nameInput.autocomplete = "off";
    nameInput.spellcheck = false;

    // 模板单选（kit.radioGroup 不依赖 host——纯 UI 积木，静态复用）
    const tplLabel = document.createElement("div");
    tplLabel.className = "scaffold-field-label";
    tplLabel.textContent = t("ext.fieldTpl");
    const tplGroup = createScaffoldTemplateGroup();

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = t("ext.cancel");
    const okBtn = document.createElement("button");
    okBtn.className = "btn btn--primary";
    okBtn.textContent = t("ext.create");
    actions.append(cancelBtn, okBtn);

    card.append(title, idLabel, idInput, nameLabel, nameInput, tplLabel, tplGroup.el, actions);
    overlay.appendChild(card);
    const done = (v: { id: string; name: string; template: "panel" | "inline" | "blank" } | null): void => {
      overlay.remove();
      resolve(v);
    };
    const submit = (): void => {
      const id = idInput.value.trim();
      const name = nameInput.value.trim();
      if (!id || !name) {
        toast(t("ext.needIdAndName"), "info");
        return;
      }
      done({ id, name, template: tplGroup.get() });
    };
    okBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", () => done(null));
    for (const input of [idInput, nameInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        else if (e.key === "Escape") done(null);
      });
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(null);
    });
    document.body.appendChild(overlay);
    idInput.focus();
  });
}

/** 模板单选组（内联 WAI-ARIA radiogroup——与 kit.radioGroup 同范式，此处无 host 故本地实现） */
function createScaffoldTemplateGroup(): { el: HTMLElement; get(): "panel" | "inline" | "blank" } {
  const OPTIONS: Array<{ value: "panel" | "inline" | "blank"; label: string; desc: string }> = [
    { value: "panel", label: t("ext.tplPanel"), desc: t("ext.tplPanelDesc") },
    { value: "inline", label: t("ext.tplInline"), desc: t("ext.tplInlineDesc") },
    { value: "blank", label: t("ext.tplBlank"), desc: t("ext.tplBlankDesc") },
  ];
  const root = document.createElement("div");
  root.className = "tool-radiogroup scaffold-templates";
  root.setAttribute("role", "radiogroup");
  root.setAttribute("aria-label", t("ext.fieldTpl"));
  let selected: "panel" | "inline" | "blank" = "panel";
  const radios = OPTIONS.map((o) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tool-radio scaffold-template";
    btn.dataset.value = o.value;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(o.value === selected));
    btn.tabIndex = o.value === selected ? 0 : -1;
    const dot = document.createElement("span");
    dot.className = "tool-radio-dot";
    btn.appendChild(dot);
    const text = document.createElement("span");
    text.className = "tool-radio-text";
    const name = document.createElement("div");
    name.textContent = o.label;
    const desc = document.createElement("div");
    desc.className = "scaffold-template-desc";
    desc.textContent = o.desc;
    text.append(name, desc);
    btn.appendChild(text);
    btn.addEventListener("click", () => select(o.value));
    root.appendChild(btn);
    return btn;
  });
  const select = (v: "panel" | "inline" | "blank"): void => {
    selected = v;
    for (const r of radios) {
      const sel = r.dataset.value === v;
      r.setAttribute("aria-checked", String(sel));
      r.tabIndex = sel ? 0 : -1;
    }
  };
  return { el: root, get: () => selected };
}

/** 单个插件行（点击展开详情 + 操作） */
function renderPluginRow(rec: PluginRecord): HTMLElement {
  const row = document.createElement("div");
  row.className = `plugin-row plugin-row--${rec.status}`;

  const head = document.createElement("div");
  head.className = "plugin-row-head";
  const caret = codicon("chevron-right");
  caret.classList.add("plugin-caret");
  const icon = codicon(rec.status === "error" ? "error" : rec.status === "disabled" ? "circle-slash" : "extensions");
  const name = document.createElement("span");
  name.className = "plugin-name";
  name.textContent = rec.name;
  const meta = document.createElement("span");
  meta.className = "plugin-meta";
  const toolCount = rec.toolIds.length > 0 ? t("ext.toolCountSuffix", { count: rec.toolIds.length }) : "";
  const statusText = rec.status === "active" ? t("ext.statusActive") : rec.status === "disabled" ? t("ext.statusDisabled") : rec.status === "error" ? t("ext.statusError") : "";
  meta.textContent = t("ext.meta", { source: rec.source === "builtin" ? t("ext.sourceBuiltin") : t("ext.sourceGlobal"), tools: toolCount, status: statusText });
  head.append(caret, icon, name, meta);
  row.appendChild(head);

  // 展开区（懒渲染：首次展开才填内容）
  let detailEl: HTMLElement | null = null;
  head.addEventListener("click", () => {
    const open = row.classList.toggle("open");
    caret.classList.toggle("codicon-chevron-down", open);
    caret.classList.toggle("codicon-chevron-right", !open);
    if (open && !detailEl) {
      detailEl = renderPluginDetail(rec);
      row.appendChild(detailEl);
    } else if (detailEl) {
      detailEl.classList.toggle("hidden", !open);
    }
  });

  return row;
}

/** 展开详情：版本/引擎/权限/工具 + 操作按钮 + 日志 */
function renderPluginDetail(rec: PluginRecord): HTMLElement {
  const detail = document.createElement("div");
  detail.className = "plugin-detail";

  const line = (label: string, value: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = "plugin-detail-line";
    const l = document.createElement("span");
    l.className = "plugin-detail-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.textContent = value;
    el.append(l, v);
    return el;
  };

  detail.append(line(t("ext.fieldVersion"), rec.version));
  if (rec.manifest?.engines) detail.append(line(t("ext.fieldEngines"), rec.manifest.engines.pylume));
  detail.append(line(t("ext.fieldPermissions"), (rec.manifest?.permissions ?? []).join(", ") || t("ext.permDefault")));

  const toolTitles = (rec.manifest?.contributes?.tools ?? []).map((t) => t.title).join("、");
  if (toolTitles) detail.append(line(t("ext.fieldTools"), toolTitles));
  if (rec.error) {
    const err = document.createElement("div");
    err.className = "plugin-error-msg";
    err.textContent = rec.error;
    detail.appendChild(err);
  }

  // 操作行
  const actions = document.createElement("div");
  actions.className = "plugin-actions";
  const reloadBtn = document.createElement("button");
  reloadBtn.className = "btn btn--sm";
  reloadBtn.textContent = t("ext.reload");
  reloadBtn.addEventListener("click", () => void reloadPlugin(rec.id).then(() => renderPluginsTab()));
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "btn btn--sm";
  if (rec.status === "disabled") {
    toggleBtn.textContent = t("ext.enable");
    toggleBtn.addEventListener("click", () => void enablePlugin(rec.id).then(() => renderPluginsTab()));
  } else {
    toggleBtn.textContent = t("ext.disable");
    toggleBtn.classList.add("btn--danger-outline");
    toggleBtn.addEventListener("click", () => void disablePlugin(rec.id).then(() => renderPluginsTab()));
  }
  actions.append(reloadBtn, toggleBtn);
  // P2 分发：导出 zip（仅第三方插件；内置随应用分发无意义）
  if (rec.source === "global") {
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn btn--sm";
    exportBtn.textContent = t("ext.export");
    exportBtn.addEventListener("click", () => void exportPluginZip(rec));
    actions.append(exportBtn);
  }
  detail.appendChild(actions);

  // 日志面板常驻（host.log 是插件作者的主要调试通道——空态也展示位置，引导其存在感）
  const logBox = document.createElement("div");
  logBox.className = "plugin-logs";
  const logTitle = document.createElement("div");
  logTitle.className = "plugin-logs-title";
  // v1.1（§9.14）：日志同时落盘（跨重启可查），面板只展示本会话内存环形
  logTitle.textContent = t("ext.logTitle");
  logBox.appendChild(logTitle);
  const lines = rec.logs.slice(-50);
  if (lines.length === 0) {
    const emptyLog = document.createElement("div");
    emptyLog.className = "plugin-log-line plugin-log-empty";
    emptyLog.textContent = t("ext.noLogHint");
    logBox.appendChild(emptyLog);
  } else {
    for (const { t, msg } of lines) {
      const lineEl = document.createElement("div");
      lineEl.className = "plugin-log-line";
      const time = new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
      lineEl.textContent = `${time}  ${msg}`;
      logBox.appendChild(lineEl);
    }
  }
  detail.appendChild(logBox);

  return detail;
}
