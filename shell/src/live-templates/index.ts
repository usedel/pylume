// Live Templates 入口：配置加载（三层）+ registry 构建 + 触发器注册（方案 §3）
// M2 增补：documentSymbol 符号上下文缓存（§6.2）+ 管理面板配置读写 API（§10）

import { invoke } from "@tauri-apps/api/core";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { onLocaleChange } from "../i18n"; // 第十九批 i18n：语言切换重跑 rebuild（刷新内置模板描述）
import { parseTemplatesFile, type TemplateDef, type TemplatesFile } from "./schema";
import { TemplateRegistry, type EffectiveEntry, type TemplateLayer } from "./registry";
import { registerTemplateCompletion, setForceShowAll } from "./completion";
import { registerTabExpand } from "./tabExpand";
import { registerSurround } from "./surround";
import { registerPalette } from "./palette";
import { templateReferences, type EngineContext } from "./engine";
import { resolveSyntaxContext, type SyntaxContext } from "./scope";
import { compileTemplate } from "./compiler";
import { insertSnippet } from "./snippet";
import { SymbolIndex, type RawSymbol } from "./symbols";
import { registerDocstringTrigger } from "./docstring";

type Monaco = typeof MonacoApi;

export { setForceShowAll };
export type { EffectiveEntry, TemplateLayer, TemplateDef, TemplatesFile };

export type ConfigLayer = "user" | "workspace";

export interface LiveTemplatesHost {
  getWorkspaceRoot(): string | null;
  /** M2：documentSymbol 取数器（LSP 桥注入）；未注入则恒走启发式兜底 */
  fetchDocumentSymbols?: (path: string) => Promise<RawSymbol[]>;
  /** M2：model → 文件路径（LSP 桥标记）；未注入时用 model.uri.fsPath */
  getModelPath?: (model: MonacoApi.editor.ITextModel) => string | null;
}

export interface LiveTemplatesHandle {
  /** 重读用户/工作区配置并重建 registry（打开工作区 / 热重载调用） */
  reload(): Promise<void>;
  dispose(): void;
  /** 打开模板面板（快捷键经 keybindings.ts 的 template_palette 配置） */
  openPalette(): void;
  /** 打开环绕模板选择器（快捷键经 keybindings.ts 的 surround 配置；需选区） */
  openSurround(): void;
  /** 在当前光标处按缩写插入模板（如新建文件后自动插 header 文件头）；未命中返回 false */
  insertByAbbreviation(abbr: string): Promise<boolean>;
  // —— M2 管理面板 API ——
  listEffective(): EffectiveEntry[];
  getFile(layer: ConfigLayer): TemplatesFile | null;
  /** 写入配置文件并立即重建 registry（保存即生效） */
  saveFile(layer: ConfigLayer, file: TemplatesFile): Promise<void>;
}

/** 剪贴板预取缓存窗口：同一轮补全/展开内不重复读 */
const CLIPBOARD_CACHE_MS = 2000;

export async function initLiveTemplates(
  monaco: Monaco,
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  host: LiveTemplatesHost,
): Promise<LiveTemplatesHandle> {
  const registry = new TemplateRegistry();
  const symbolIndex = host.fetchDocumentSymbols ? new SymbolIndex(host.fetchDocumentSymbols) : null;

  // 用户名（user() 函数）：失败回落空串 → 求值失败走 defaultValue
  let userName = "";
  try {
    userName = await invoke<string>("get_user_name");
  } catch {
    /* ignore */
  }

  // 输入法组合期门控（S1-T06 中文输入经验）：组合中不展开
  let composing = false;
  const compStart = editor.onDidCompositionStart(() => {
    composing = true;
  });
  const compEnd = editor.onDidCompositionEnd(() => {
    composing = false;
  });

  let clipboardCache: { at: number; text: string | null } = { at: 0, text: null };
  async function readClipboard(): Promise<string | null> {
    const now = Date.now();
    if (now - clipboardCache.at < CLIPBOARD_CACHE_MS) return clipboardCache.text;
    let text: string | null = null;
    try {
      // Rust 侧已注册 tauri-plugin-clipboard-manager；直连 IPC 命令，免引 JS 包
      const v = await invoke<string | null>("plugin:clipboard-manager|read_text");
      text = v ?? null;
    } catch {
      text = null;
    }
    clipboardCache = { at: now, text };
    return text;
  }

  function modelPathOf(model: MonacoApi.editor.ITextModel): string {
    return host.getModelPath?.(model) ?? model.uri.fsPath;
  }

  /** M2 双路上下文判定：符号缓存优先（stale-while-revalidate），启发式兜底 */
  function getScopeInfo(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position): SyntaxContext {
    const symbols = symbolIndex ? symbolIndex.lookup(modelPathOf(model), model) : null;
    return resolveSyntaxContext(model, position, symbols);
  }

  async function buildEngineContext(
    model: MonacoApi.editor.ITextModel,
    position: MonacoApi.Position,
    tpl: TemplateDef,
  ): Promise<EngineContext> {
    const path = modelPathOf(model);
    const fileName = path.split(/[\\/]/).pop() ?? path;
    const root = host.getWorkspaceRoot();
    let rel = fileName;
    if (root) {
      const norm = (s: string): string => s.replace(/\\/g, "/");
      const p = norm(path);
      const r = norm(root);
      if (p.toLowerCase().startsWith(r.toLowerCase())) {
        rel = p.slice(r.length).replace(/^\/+/, "");
      }
    }
    const scopeInfo = getScopeInfo(model, position);
    const clipboardText = templateReferences(tpl, "clipboard") ? await readClipboard() : null;
    return {
      fileName,
      filePath: path,
      fileRelativePath: rel,
      className: scopeInfo.className,
      methodName: scopeInfo.methodName,
      lineNumber: position.lineNumber,
      userName,
      clipboardText,
      variableValues: new Map(),
    };
  }

  const completionDisposable = registerTemplateCompletion(monaco, registry, {
    buildEngineContext,
    resolveScopeInfo: getScopeInfo,
  });
  const tabDisposable = registerTabExpand(monaco, editor, registry, {
    buildEngineContext,
    isComposing: () => composing,
    resolveScopeInfo: getScopeInfo,
  });
  // tech-debt #16：`"""` + Enter 自动生成 docstring（对标 PyCharm）
  const docstringTrigger = registerDocstringTrigger(monaco, editor);
  const surroundHandle = registerSurround(editor, registry, {
    buildEngineContext,
    resolveScopeInfo: getScopeInfo,
  });
  const paletteHandle = registerPalette(editor, registry, {
    buildEngineContext,
    resolveScopeInfo: getScopeInfo,
  });

  /** 按缩写在当前光标处插入模板（供新建文件后自动展开 header 等场景）；未命中/无编辑器返回 false */
  async function insertByAbbreviation(abbr: string): Promise<boolean> {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return false;
    const ctx = getScopeInfo(model, position);
    const tpl = registry.findByAbbreviation(abbr, ctx);
    if (!tpl) return false;
    const engineCtx = await buildEngineContext(model, position, tpl);
    return insertSnippet(editor, compileTemplate(tpl, engineCtx));
  }

  let userFile: TemplatesFile | null = null;
  let workspaceFile: TemplatesFile | null = null;

  async function readConfig(read: () => Promise<string | null>): Promise<TemplatesFile | null> {
    try {
      const raw = await read();
      if (!raw) return null;
      const parsed = parseTemplatesFile(raw);
      if (!parsed) {
        console.warn("[live-templates] 配置格式非法，已忽略");
        return null;
      }
      for (const e of parsed.errors) console.warn("[live-templates]", e);
      return parsed.file;
    } catch (e) {
      console.warn("[live-templates] 配置加载失败", e);
      return null;
    }
  }

  async function reload(): Promise<void> {
    userFile = await readConfig(() => invoke<string | null>("read_templates_config"));
    const root = host.getWorkspaceRoot();
    workspaceFile = root
      ? await readConfig(() =>
          invoke<string>("read_file", { path: joinPath(root, ".pylume/templates.json") }).catch(
            () => null,
          ),
        )
      : null;
    registry.rebuild(userFile, workspaceFile);
  }
  await reload();

  // 第十九批 i18n：BUILTIN_TEMPLATES 随语言重建（builtin.ts 模块级订阅先于此执行），
  // registry 快照里是重建前的定义引用——重跑 rebuild 让 slots 拿到新语言描述。
  // 管理面板列表重绘由 manager.ts 自己的 onLocaleChange 订阅负责（后注册、后执行）。
  // 退订句柄保存在 handle 上：dispose() 时注销，防止销毁后的 handle 在语言切换时仍被重建。
  const offLocale = onLocaleChange(() => {
    registry.rebuild(userFile, workspaceFile);
  });

  async function saveFile(layer: ConfigLayer, file: TemplatesFile): Promise<void> {
    const content = JSON.stringify(file, null, 2);
    await invoke("write_templates_config", {
      scope: layer,
      workspaceRoot: layer === "workspace" ? host.getWorkspaceRoot() : null,
      content,
    });
    if (layer === "user") userFile = file;
    else workspaceFile = file;
    registry.rebuild(userFile, workspaceFile); // 保存即生效
  }

  return {
    reload,
    dispose() {
      offLocale();
      compStart.dispose();
      compEnd.dispose();
      completionDisposable.dispose();
      tabDisposable.dispose();
      docstringTrigger.dispose();
      surroundHandle.dispose();
      paletteHandle.dispose();
      symbolIndex?.clear();
    },
    openPalette: () => paletteHandle.open(),
    openSurround: () => surroundHandle.open(),
    insertByAbbreviation,
    listEffective: () => registry.listEffective(),
    getFile: (layer) => (layer === "user" ? userFile : workspaceFile),
    saveFile,
  };
}

/** 路径拼接（Windows/Unix 通用） */
function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return base.endsWith(sep) ? base + rel : base + sep + rel;
}
