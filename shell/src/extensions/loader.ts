// 插件加载器（PR-2，plugin_system_design §9.5 / §9.15）：发现 → 校验 → 动态 import → 注册 → 热重载。
//
// 关键设计：
// - 单文件 entry 约定（决策点 #14）：cache-bust 只作用入口 URL，禁插件内相对 import；
// - 热重载 = 去抖 + 全量 diff（manifest + 各 entry 内容），不依赖细粒度文件事件；
// - 工具注册进 devtools registry（pluginToolId 全局键），菜单/picker/命令面板自动跟随；
// - 加载失败插件记 PluginRecord(error)，不阻塞其他插件（§9.5「跳过并上报」）。

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import { errMsg } from "../util";
import { t, type TFuncKey } from "../i18n"; // 第十五批 i18n：插件加载动态文案走语言包
import { localizeBackendError } from "../i18n/backendError";
import { registerDevTool, unregisterDevTool } from "../devtools/registry";
import type { DevTool, ToolInstance } from "../devtools/types";
import { createPanelHost, clearPluginStorage, type FacadeDeps, type InlineHost, type PanelHost } from "./facade";
import { checkEnginesCompatible, pluginToolId, validateManifest, type PluginManifest, type PluginToolContribution } from "./manifest";

/** 当前应用版本（engines 兼容检查用；main.ts 注入真实值，测试可覆盖） */
export let APP_VERSION = "0.1.0";
export function setAppVersion(v: string): void {
  APP_VERSION = v;
}

/** 停用清单持久化键（插件 id 数组） */
const DISABLED_KEY = "pylume.plugins.disabled";

/** 工具模块须导出的契约面（§9.3） */
export interface ToolModule {
  mount?: (host: PanelHost) => ToolInstance | void;
  [handler: string]: unknown; // inline handler 按 manifest.inline.handler 名取
}

/** 插件运行记录（设置页「插件」tab 数据源，§9.14） */
export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  source: "builtin" | "global";
  dir: string;
  manifest: PluginManifest;
  status: "active" | "disabled" | "error";
  error?: string;
  toolIds: string[];
  logs: { t: number; msg: string }[];
}

// ---------- 模块状态 ----------

const records = new Map<string, PluginRecord>(); // key = plugin id
const moduleUrls = new Map<string, string>(); // key = `${pluginId}::${toolId}` → objectURL（revoke 用）
const entryHashes = new Map<string, string>(); // key 同上 → entry 内容 hash（diff 用）
let facadeDeps: FacadeDeps | null = null;
let refreshUi: (() => void) | null = null; // 注册表变更后通知（panel/菜单/命令面板刷新）
let scanToken = 0; // 异步刷新请求令牌（防并发扫描竞态）

/** 注入外壳依赖 + UI 刷新回调（main.ts 启动时调用一次）。
 *  deps.pluginLog 由本函数自动补齐（写插件记录日志）——main.ts 不需要关心它。 */
export function initPluginLoader(deps: FacadeDeps, onRegistryChanged: () => void): void {
  facadeDeps = { ...deps, pluginLog: writePluginLog };
  refreshUi = onRegistryChanged;
}

/** host.log 落点：写该插件的记录日志（设置页日志面板可见；未注册插件静默丢弃）。
 *  v1.1（§9.14）：旁路落盘 `<data_root>/logs/plugins/<id>.log`（跨重启诊断）——
 *  fire-and-forget，失败静默（诊断日志不得反噬主流程；Rust 侧自带 id 收口与滚动截断）。 */
function writePluginLog(pluginId: string, msg: string): void {
  const rec = records.get(pluginId);
  if (rec) log(rec, msg);
  void invoke("append_plugin_log", {
    pluginId,
    line: `${formatLogTime(Date.now())} ${msg.replace(/\r?\n/g, " ")}`,
  }).catch(() => undefined);
}

function log(rec: PluginRecord, msg: string): void {
  const t = Date.now();
  rec.logs.push({ t, msg });
  if (rec.logs.length > 50) rec.logs.splice(0, rec.logs.length - 50); // 环形 50（§9.14）
}

/** 日志时间戳（落盘行前缀；带日期——跨重启诊断须能区分是哪天，比面板的时分秒格式多一层日期） */
function formatLogTime(t: number): string {
  const d = new Date(t);
  const pad = (x: number): string => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------- 停用清单 ----------

function loadDisabled(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveDisabled(ids: Set<string>): void {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...ids]));
  } catch {
    /* 存储不可用静默降级 */
  }
}

// ---------- 动态 import（Blob URL + cache-bust） ----------

/** 简单内容 hash（diff 与 cache-bust 共用；非加密用途） */
function hashContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

async function importToolModule(pluginDir: string, entry: string, pluginId: string, toolId: string): Promise<ToolModule> {
  const code = await invoke<string>("read_plugin_file", { pluginDir, rel: entry });
  const key = `${pluginId}::${toolId}`;
  entryHashes.set(key, hashContent(code));
  // revoke 旧 URL（热重载）。cache-bust 说明：blob URL 每次 createObjectURL 生成全新 UUID，
  // 天然免缓存——**不能**再拼 ?v= query（Chromium 对带 query 的 blob URL 动态 import 直接
  // Failed to fetch，PR-4 E2E 实测踩坑）
  const old = moduleUrls.get(key);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  moduleUrls.set(key, url);
  const mod = (await import(/* @vite-ignore */ url)) as ToolModule;
  return mod;
}

// ---------- 注册 / 注销 ----------

function registerPluginTool(rec: PluginRecord, tc: PluginToolContribution, mod: ToolModule): void {
  const gid = pluginToolId(rec.id, tc.id);
  const manifest = rec.manifest;
  const hasMount = typeof mod.mount === "function";
  const tool: DevTool = {
    id: gid,
    title: tc.title,
    description: tc.description ?? "",
    category: tc.category?.trim() || t("ext.categoryOther"),
    icon: tc.icon || "symbol-extension",
    inlineLabel: tc.inline?.label ?? null,
    mount(host): ToolInstance | void {
      if (!facadeDeps) throw new Error("插件系统未初始化");
      // PR-3：host.root = panel 分配给本工具的独立 rootEl（devtools/panel.ts 缓存单元）；
      // facade 按 manifest 权限门控，kit/output 注入外壳 Monaco（与权限解耦）
      const panelHost = createPanelHost(manifest, rec.dir, host.root, facadeDeps);
      if (hasMount) {
        return mod.mount!(panelHost) as ToolInstance | void;
      }
      // P1 DX：inline-only 工具（无 mount 导出）自动获得「调试台」——
      // 不选编辑器文本也能验证 handler：输入 → 运行 → 结果/错误就地展示。
      return mountInlineDebugBench(panelHost, tc, mod);
    },
  };
  registerDevTool(tool);
  if (!rec.toolIds.includes(gid)) rec.toolIds.push(gid);
}

/** inline-only 工具的自动调试台（P1 DX）：与 runInline 同一 handler 语义（抛错显示不清空结果） */
function mountInlineDebugBench(host: PanelHost, tc: PluginToolContribution, mod: ToolModule): void {
  const { kit } = host;
  const wrap = kit.body();

  const hint = document.createElement("div");
  hint.className = "tool-label";
  hint.textContent = t("ext.inlineHint", { label: tc.inline?.label ?? tc.title });

  const input = kit.textarea({ placeholder: t("ext.testPlaceholder"), flex: true });
  const out = kit.output({ placeholder: t("ext.resultPlaceholder") });
  const errEl = kit.errorSlot();

  const run = async (): Promise<void> => {
    const text = input.value;
    if (!text) {
      errEl.textContent = t("ext.needInput");
      return;
    }
    try {
      const fn = mod[tc.inline?.handler ?? ""];
      // 含 \" 转义引号的文案不走 apply_ts 映射（语言包转义链失真），手工取词
      if (typeof fn !== "function") throw new Error(t("ext.handlerNotExported", { handler: tc.inline?.handler ?? "" }));
      // 注意：调试台传的是 PanelHost（含 kit/root）——比 inline 真实环境更宽松，
      // handler 不应依赖这些额外能力（真实 inline 只有无 UI 的 BaseHost）
      const result = await (fn as (t: string, h: PanelHost) => unknown)(text, host);
      if (typeof result !== "string") throw new Error(t("ext.handlerNotString"));
      out.set(result);
      errEl.textContent = "";
    } catch (e) {
      errEl.textContent = t("ext.transformFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) });
    }
  };

  const runBtn = kit.primaryButton(t("ext.run"), "play", () => void run());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void run();
  });

  wrap.append(hint, input, kit.toolbar(runBtn, "spacer", kit.copyButton(() => out.get())), errEl, out.el);
  host.root.appendChild(wrap);
}

/** inline handler 解析（供 runInline 调用；返回 null = 该工具无 inline） */
export function getInlineHandler(rec: PluginRecord, toolGlobalId: string): { label: string; run: (text: string, host: InlineHost) => unknown } | null {
  const tc = rec.manifest.contributes?.tools?.find((t) => pluginToolId(rec.id, t.id) === toolGlobalId);
  if (!tc?.inline) return null;
  const label = tc.inline.label;
  const handlerName = tc.inline.handler;
  const mod = loadedModules.get(toolGlobalId);
  if (!mod) return null;
  const fn = mod[handlerName];
  if (typeof fn !== "function") return null;
  return {
    label,
    run: (text, host) => (fn as (text: string, host: InlineHost) => unknown)(text, host),
  };
}

/** 已加载工具模块表（key = 工具全局键；getInlineHandler 与热重载 diff 用） */
const loadedModules = new Map<string, ToolModule>();

function unregisterPlugin(rec: PluginRecord): void {
  for (const gid of rec.toolIds) {
    unregisterDevTool(gid);
    loadedModules.delete(gid);
    // gid = `<pluginId>.<toolId>`，pluginId 可含点（反向域名）——按前缀长度切，不能 split(".")
    const toolId = gid.slice(rec.id.length + 1);
    const key = `${rec.id}::${toolId}`;
    const url = moduleUrls.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      moduleUrls.delete(key);
    }
    entryHashes.delete(key);
  }
  rec.toolIds = [];
}

// ---------- 内置插件注册（PR-3，§9.7 dogfooding） ----------

/** 内置模块表快照（registerBuiltinPlugin 时留存——enablePlugin 重注册复用，
 *  避免 loader 反向 import builtin/index 造成循环依赖） */
let builtinModules: Record<string, ToolModule> = {};

/** 内置工具模块注册入口：静态 import 的模块 + 内联 manifest，走与第三方相同的注册路径。
 *  幂等：重复调用只重注册一次（dev HMR 场景）。 */
export function registerBuiltinPlugin(manifest: PluginManifest, modules: Record<string, ToolModule>): void {
  const existing = records.get(manifest.id);
  if (existing) unregisterPlugin(existing); // 幂等重入
  builtinModules = modules; // 留存快照（停用→启用时 enablePlugin 复用）

  // 停用清单检查：启动重注册（initDevTools）时也要尊重用户的停用状态——
  // 否则「停用内置插件 → 重启」会静默恢复，停用形同虚设
  const disabledNow = loadDisabled().has(manifest.id);

  const rec: PluginRecord = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    source: "builtin",
    dir: "(builtin)",
    manifest,
    status: disabledNow ? "disabled" : "active",
    toolIds: [],
    logs: [],
  };
  records.set(manifest.id, rec);
  if (disabledNow) {
    log(rec, t("ext.skippedDisabled"));
    refreshUi?.();
    return;
  }

  for (const tc of manifest.contributes?.tools ?? []) {
    const mod = modules[tc.entry];
    if (!mod) {
      console.warn(`[extensions] 内置工具缺模块：${tc.entry}`);
      continue;
    }
    const gid = pluginToolId(manifest.id, tc.id);
    loadedModules.set(gid, mod);
    registerPluginTool(rec, tc, mod);
  }
  log(rec, t("ext.builtinRegistered", { count: rec.toolIds.length }));
  refreshUi?.();
}

// ---------- 扫描与加载 ----------

/** 全量扫描（启动 + 「重新扫描」按钮 + 热重载 diff 共用）。
 *  diff 语义：目录集合变化 → 增/删插件；manifest/entry 内容变化 → 重载该插件。 */
export async function scanPlugins(): Promise<void> {
  const token = ++scanToken;
  if (!facadeDeps) return;

  let dirs: Array<{ dir_name: string; dir_path: string }>;
  try {
    dirs = await invoke<Array<{ dir_name: string; dir_path: string }>>("list_plugin_dirs");
  } catch (e) {
    console.warn("[extensions] 扫描插件目录失败", e);
    return;
  }
  if (token !== scanToken) return; // 并发扫描：后发者胜，旧结果丢弃

  const disabled = loadDisabled();
  const seenIds = new Set<string>();

  for (const d of dirs) {
    if (token !== scanToken) return;
    // 目录名约定 = plugin id（list_plugin_dirs 只列含 manifest 的目录）
    const pluginId = d.dir_name;
    seenIds.add(pluginId);

    let manifestJson: string;
    try {
      manifestJson = await invoke<string>("read_plugin_file", { pluginDir: d.dir_path, rel: "pylume.plugin.json" });
    } catch (e) {
      upsertRecord(pluginId, d.dir_path, {
        id: pluginId, name: pluginId, version: "?", source: "global", dir: d.dir_path,
        manifest: null, error: t("ext.manifestReadFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }),
      });
      continue;
    }

    const check = validateManifest(manifestJson);
    if (!check.ok) {
      upsertRecord(pluginId, d.dir_path, {
        id: pluginId, name: pluginId, version: "?", source: "global", dir: d.dir_path,
        manifest: null, error: `${t("ext.manifestCheckFailed")}\n${check.errors.map((e) => t(e.key as TFuncKey, e.params)).join("\n")}`,
      });
      continue;
    }
    const manifest = check.manifest!;

    if (manifest.id !== pluginId) {
      upsertRecord(pluginId, d.dir_path, {
        id: pluginId, name: manifest.name, version: manifest.version, source: "global", dir: d.dir_path,
        manifest, error: t("ext.idDirMismatch", { id: manifest.id, dir: pluginId }),
      });
      continue;
    }

    if (!checkEnginesCompatible(manifest.engines.pylume, APP_VERSION)) {
      upsertRecord(pluginId, d.dir_path, {
        id: pluginId, name: manifest.name, version: manifest.version, source: "global", dir: d.dir_path,
        manifest, error: t("ext.engineIncompatible", { required: manifest.engines.pylume, current: APP_VERSION }),
      });
      continue;
    }

    if (disabled.has(pluginId)) {
      upsertRecord(pluginId, d.dir_path, {
        id: pluginId, name: manifest.name, version: manifest.version, source: "global", dir: d.dir_path,
        manifest, status: "disabled",
      });
      continue;
    }

    // 热重载 diff（§9.15）：已 active 且 manifest 与各 entry 内容 hash 均未变 → 跳过（保护面板输入态）
    const existing = records.get(pluginId);
    if (existing?.status === "active" && existing.toolIds.length > 0) {
      const manifestChanged = JSON.stringify(existing.manifest) !== JSON.stringify(manifest);
      let entriesChanged = false;
      if (!manifestChanged) {
        for (const tc of manifest.contributes?.tools ?? []) {
          try {
            const code = await invoke<string>("read_plugin_file", { pluginDir: d.dir_path, rel: tc.entry });
            if (entryHashes.get(`${pluginId}::${tc.id}`) !== hashContent(code)) {
              entriesChanged = true;
              break;
            }
          } catch {
            entriesChanged = true; // 读失败视为变化（让 loadPluginTools 报出明确错误）
            break;
          }
        }
      }
      if (!manifestChanged && !entriesChanged) continue; // 无变化：跳过重载
    }

    await loadPluginTools(pluginId, d.dir_path, manifest);
  }

  // 目录消失的插件：注销 + 删记录（内置插件 source=builtin 不在磁盘，跳过）
  for (const id of [...records.keys()]) {
    const rec = records.get(id)!;
    if (rec.source === "global" && !seenIds.has(id)) {
      unregisterPlugin(rec);
      records.delete(id);
    }
  }

  refreshUi?.();
}

/** 加载单个插件的全部工具（manifest 已校验）；任一 entry 失败 → 整包 error（宁整包失败不半加载）。
 *  重入语义（热重载）：先注销该插件既有工具（registry 里 id 重复会被拒，不先注销则新代码永远注册不上），
 *  再走 import → 注册全流程；面板存活实例由 onRegistryChanged 联动清理。 */
async function loadPluginTools(pluginId: string, dir: string, manifest: PluginManifest): Promise<void> {
  const tools = manifest.contributes?.tools ?? [];
  const rec: PluginRecord = upsertRecord(pluginId, dir, { id: pluginId, name: manifest.name, version: manifest.version, source: "global", dir, manifest });
  if (rec.toolIds.length > 0) {
    log(rec, t("ext.reregistering"));
    unregisterPlugin(rec);
    reloadSeq++; // 热重载发生（状态不变也要让变更检测感知）
  }
  log(rec, t("ext.loadingTools", { count: tools.length }));

  // 先全部 import 成功，再统一注册（半加载 = 部分工具可见但插件标 error，难以排查）
  const loaded: Array<{ tc: PluginToolContribution; mod: ToolModule }> = [];
  for (const tc of tools) {
    try {
      const mod = await importToolModule(dir, tc.entry, pluginId, tc.id);
      if (typeof mod.mount !== "function" && !tc.inline) {
        throw new Error(t("ext.noMount", { id: tc.id }));
      }
      loaded.push({ tc, mod });
    } catch (e) {
      const msg = t("ext.toolLoadFailed", { id: tc.id, error: e instanceof Error ? e.message : String(e) });
      rec.status = "error";
      rec.error = msg;
      log(rec, msg);
      console.warn(`[extensions] ${msg}`); // 设置页记录 UI 之外的可见通道（排查第三方插件问题）
      // 回滚已 import 的模块（blob URL revoke）
      for (const { tc: done } of loaded) {
        const key = `${pluginId}::${done.id}`;
        const url = moduleUrls.get(key);
        if (url) URL.revokeObjectURL(url);
        moduleUrls.delete(key);
        entryHashes.delete(key);
      }
      return;
    }
  }

  for (const { tc, mod } of loaded) {
    const gid = pluginToolId(pluginId, tc.id);
    loadedModules.set(gid, mod);
    registerPluginTool(rec, tc, mod);
  }
  rec.status = "active";
  rec.error = undefined;
  log(rec, t("ext.loaded", { list: loaded.map((x) => x.tc.title).join("、") }));
}

/** 记录 upsert 简化：必要时新建记录，否则更新元数据 + 可选覆盖 status/error */
function upsertRecord(pluginId: string, dir: string, init: {
  id: string; name: string; version: string; source: "builtin" | "global"; dir: string;
  manifest: PluginManifest | null; status?: PluginRecord["status"]; error?: string;
}): PluginRecord {
  let rec = records.get(pluginId);
  if (!rec) {
    rec = {
      id: pluginId, name: init.name, version: init.version, source: init.source, dir,
      manifest: init.manifest as PluginManifest,
      status: init.error !== undefined ? "error" : init.status ?? "active",
      error: init.error, // 新建分支必须带上（E2E 揭露：曾只写日志漏赋值 → 设置页无错误详情）
      toolIds: [], logs: [],
    };
    records.set(pluginId, rec);
  } else {
    rec.name = init.name;
    rec.version = init.version;
    rec.dir = dir;
    if (init.manifest) rec.manifest = init.manifest;
    if (init.status) rec.status = init.status;
    if (init.error !== undefined) rec.error = init.error;
    else if (init.status === "active") rec.error = undefined;
  }
  if (init.error !== undefined) {
    rec.status = "error";
    log(rec, init.error);
  }
  return rec;
}

// ---------- 热重载（去抖 + 全量 diff） ----------

let reloadTimer: number | undefined;

/** 目录变更信号入口（Rust plugins-dir-changed 事件 → 此处去抖）。
 *  无变化不提示（目录里的无关文件也会触发 watcher，避免噪音）。 */
export function schedulePluginRescan(): void {
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    const before = pluginStateSnapshot();
    void scanPlugins().then(() => {
      // 快照含 reloadSeq（loadPluginTools 每次实际重载 +1）——
      // 热重载同版本重载时 id/status/toolIds 均不变，但不提示会让用户以为没生效
      if (pluginStateSnapshot() !== before) toast(t("ext.reloaded"), "success");
    });
  }, 400);
}

/** 实际发生的重载计数（变化检测的一部分：热重载即使状态不变也算「变化」） */
let reloadSeq = 0;

/** 插件状态快照（变化检测用：id/状态/工具集合/重载代数的稳定串） */
function pluginStateSnapshot(): string {
  return `${reloadSeq};` + listPluginRecords()
    .map((r) => `${r.id}:${r.status}:${[...r.toolIds].sort().join(",")}`)
    .sort()
    .join(";");
}

// ---------- 设置页操作（§9.14 行为） ----------

/** 停用插件：注销工具 + 清 storage（不删文件） */
export async function disablePlugin(pluginId: string): Promise<void> {
  const rec = records.get(pluginId);
  if (!rec) return;
  const disabled = loadDisabled();
  disabled.add(pluginId);
  saveDisabled(disabled);
  unregisterPlugin(rec);
  rec.status = "disabled";
  rec.toolIds = [];
  log(rec, t("ext.statusDisabled"));
  clearPluginStorage(pluginId);
  refreshUi?.();
}

/** 启用插件：移出停用清单 + 按来源重载。
 *  ⚠️ 内置插件（source=builtin）不在磁盘上，scanPlugins 扫不到它——必须走
 *  registerBuiltinPlugin 重注册；第三方（global）才走目录重扫。（E2E 后人工验收发现的
 *  真实缺陷：此前统一 scanPlugins，内置插件停用后启用，工具永远不回来。） */
export async function enablePlugin(pluginId: string): Promise<void> {
  const disabled = loadDisabled();
  disabled.delete(pluginId);
  saveDisabled(disabled);
  const rec = records.get(pluginId);
  if (rec?.source === "builtin") {
    registerBuiltinPlugin(rec.manifest, builtinModules);
  } else {
    await scanPlugins();
  }
  refreshUi?.();
}

/** 单插件重载（设置页「重载」按钮）：注销 → 按来源重载（builtin 走快照重注册，global 走目录重扫） */
export async function reloadPlugin(pluginId: string): Promise<void> {
  const rec = records.get(pluginId);
  if (!rec) return;
  if (rec.status !== "disabled") {
    unregisterPlugin(rec);
  }
  if (rec.source === "builtin") {
    registerBuiltinPlugin(rec.manifest, builtinModules);
  } else {
    await scanPlugins();
  }
  refreshUi?.();
}

/** 插件记录快照（设置页渲染数据源；按来源+名称排序：内置前、全局后） */
export function listPluginRecords(): PluginRecord[] {
  return [...records.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "builtin" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
}
