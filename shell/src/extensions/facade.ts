// 插件 API facade（PR-2，plugin_system_design §9.4）：按 manifest.permissions 门控的 host 工厂。
// 插件与外壳之间唯一通道：插件拿不到 state.ts / main.ts / Tauri invoke 引用。
//
// 实现说明：
// - v1 是「同 realm facade」（§9.6 受信任过渡态）：门控是软约束（拒调用 + 记日志），
//   不阻止插件读 DOM——v2 沙箱化时本文件换成跨 realm 代理，API 签名不变；
// - PanelHost / InlineHost 两型（决策点 #12）：inline 触发可能从未 mount，
//   InlineHost 不含 root/kit/monaco。

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { toast } from "../toast";
import { createToolKit } from "../devtools/kit";
import type { MonacoModule, ToolHost } from "../devtools/types";
import type { PluginManifest } from "./manifest";

/** 权限不足时抛出的错误类型（facade 内统一构造，调用方可 instanceof 识别） */
export class PermissionDeniedError extends Error {
  constructor(perm: string, method: string) {
    super(t("ext.permDenied", { perm, method }));
    this.name = "PermissionDeniedError";
  }
}

/** 通用能力（BaseHost）：两模式共有 */
export interface BaseHost {
  toast(msg: string, kind: "info" | "ok" | "error", action?: { label: string; run: () => void }): void;
  /** 插件日志通道（默认权限）：release 版 WebView 无控制台，这是插件作者唯一的
   *  调试输出——写入设置 → 插件 → 该插件行展开的日志面板（环形 50 条）。 */
  log(msg: string): void;
  copyToClipboard(text: string): Promise<boolean>;
  readClipboard(): Promise<string | null>;
  getSelectedText(): string | null;
  replaceSelection(text: string): boolean;
  insertToEditor(text: string): boolean;
  storage: { get(key: string): string | null; set(key: string, v: string): void; clear(): void };
  workspaceRoot(): string | null;
  readFile(rel: string): Promise<string>;
}

/** 面板模式：BaseHost + UI 能力（root / kit / 可选 monaco） */
export interface PanelHost extends BaseHost {
  root: HTMLElement;
  kit: ReturnType<typeof createToolKit>;
  monaco?: MonacoModule;
}

/** 就地变换模式：仅 BaseHost */
export type InlineHost = BaseHost;

/** facade 依赖的外壳能力（main.ts 注入，防反向依赖） */
export interface FacadeDeps {
  monaco: MonacoModule;
  workspaceRoot: () => string | null;
  /** 编辑器选区操作（devtools host 同款语义） */
  getSelectedText: () => string | null;
  replaceSelection: (text: string) => boolean;
  insertToEditor: (text: string) => boolean;
  /** host.log 的落点——可选：loader.initPluginLoader 自动补齐（写插件记录日志），
   *  main.ts / 测试均无需提供；仅测试需断言日志时注入。 */
  pluginLog?: (pluginId: string, msg: string) => void;
}

/** 读插件文件走 Rust 单通道（路径收口在 plugin_cmds::read_plugin_file） */
async function readPluginFile(pluginDir: string, rel: string): Promise<string> {
  return invoke<string>("read_plugin_file", { pluginDir, rel });
}

/** 权限检查器：未授权 → 记日志 + 抛 PermissionDeniedError */
function requirePerm(perms: string[], perm: string, method: string): void {
  if (!perms.includes(perm)) {
    console.warn(`[extensions] 权限拒绝: ${method}() 需要 "${perm}"（manifest 未声明）`);
    throw new PermissionDeniedError(perm, method);
  }
}

/** 构造 BaseHost（权限门控）；storage 按插件 id 命名空间隔离 */
function createBaseHost(manifest: PluginManifest, pluginDir: string, deps: FacadeDeps): BaseHost {
  const perms = manifest.permissions ?? [];
  const ns = `pylume.plugin.${manifest.id}.`;
  return {
    toast: (msg, kind, action) =>
      toast(msg, kind === "error" ? "error" : kind === "ok" ? "success" : "info", action ? { actionLabel: action.label, onAction: action.run } : {}),
    log: (msg) => deps.pluginLog?.(manifest.id, String(msg)),
    copyToClipboard: async (text) => {
      requirePerm(perms, "clipboard", "copyToClipboard");
      try {
        await invoke("copy_to_clipboard", { text });
        return true;
      } catch (e) {
        console.warn("[extensions] 复制失败", e);
        return false;
      }
    },
    readClipboard: () => {
      requirePerm(perms, "clipboard", "readClipboard");
      return readClipboardViaPlugin();
    },
    getSelectedText: () => {
      requirePerm(perms, "selection", "getSelectedText");
      return deps.getSelectedText();
    },
    replaceSelection: (text) => {
      requirePerm(perms, "selection", "replaceSelection");
      return deps.replaceSelection(text);
    },
    insertToEditor: (text) => {
      requirePerm(perms, "selection", "insertToEditor");
      return deps.insertToEditor(text);
    },
    storage: {
      get: (key) => {
        requirePerm(perms, "storage", "storage.get");
        return localStorage.getItem(ns + key);
      },
      set: (key, v) => {
        requirePerm(perms, "storage", "storage.set");
        localStorage.setItem(ns + key, v);
      },
      clear: () => {
        requirePerm(perms, "storage", "storage.clear");
        // 只清本插件命名空间（§9.4：停用/卸载时外壳清理该前缀）
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith(ns)) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
      },
    },
    workspaceRoot: () => {
      requirePerm(perms, "fs:read", "workspaceRoot");
      return deps.workspaceRoot();
    },
    readFile: (rel) => {
      requirePerm(perms, "fs:read", "readFile");
      return readPluginFile(pluginDir, rel);
    },
  };
}

/** 构造面板 host（root 每实例独立；kit 绑定本 host） */
export function createPanelHost(manifest: PluginManifest, pluginDir: string, root: HTMLElement, deps: FacadeDeps): PanelHost {
  const base = createBaseHost(manifest, pluginDir, deps);
  const host: PanelHost = { ...base, root, kit: undefined as never };
  // kit 的 copy/paste 走 host 能力（含权限门控）；构造后再回填避免引用环。
  // kit.output 的 Monaco 封装显式传入外壳模块——与权限门控的 host.monaco 解耦（无权限也可预览）
  (host as { kit: unknown }).kit = createToolKit(host as unknown as ToolHost, deps.monaco);
  if ((manifest.permissions ?? []).includes("monaco")) {
    host.monaco = deps.monaco; // 显式声明才授予裸 Monaco（决策点 #13）
  }
  return host;
}

/** 构造 inline host（无 root/kit/monaco；决策点 #12） */
export function createInlineHost(manifest: PluginManifest, pluginDir: string, deps: FacadeDeps): InlineHost {
  return createBaseHost(manifest, pluginDir, deps);
}

/** 清理插件 storage 命名空间（停用/卸载时由 loader 调用，§9.4） */
export function clearPluginStorage(pluginId: string): void {
  const ns = `pylume.plugin.${pluginId}.`;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(ns)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
}

/** clipboard-manager 读文本（与 devtools/host.ts 同源逻辑；独立实现避免测试期耦合 Tauri） */
async function readClipboardViaPlugin(): Promise<string | null> {
  try {
    const v = await invoke<string | null>("plugin:clipboard-manager|read_text");
    return v ?? null;
  } catch {
    return null;
  }
}
