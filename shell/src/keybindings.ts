// 快捷键配置域：PyCharm 风格默认键位 + 用户自定义（设置 → 快捷键）。
// 分发分两层：
// - window 级（save / run / global_search）：main.ts 的 window keydown 经 matchWindowBinding
//   实时读取 app.settings.keybindings 匹配，改键即时生效；
// - editor 级（跳转定义 / 复制行 / 注释 / 模板入口）：initKeybindingCommands 一次性注册
//   稳定命令（monaco.editor.addCommand），applyEditorKeybindings 按设置重建
//   键 → 命令映射（monaco.editor.addKeybindingRules，可反复重建）。
//   动态规则权重高于 Monaco 内建键位，同键可覆盖（如 Ctrl+D 内建「选中下一匹配」）。
// 出厂默认值出处见 keybindingDefaults.ts（单一来源，tech-debt #6）；Rust default_keybindings 由漂移锁测试兜底。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, type MonacoModule } from "./state";
import { KEYBINDING_META, type KeybindingId } from "./keybindingDefaults";
import { toast } from "./toast"; // P4（C-3）：列选择开关的可见反馈（G-3）
import { t } from "./i18n"; // 第十六批 i18n：键位校验与列选择提示走语言包
import { toggleSplit } from "./splitEditor"; // P4（C-4）：向右分屏（splitEditor 不反向依赖本模块，无环）
import { gotoMarker } from "./markerNavigation"; // 诊断导航（F8 / Shift+F8；markerNavigation 不反向依赖本模块，无环）

// re-export 出厂键位元数据，保持既有 `import ... from "./keybindings"` 调用方不变
export { KEYBINDING_META } from "./keybindingDefaults";
export type { KeybindingId, KeybindingMeta } from "./keybindingDefaults";

// ---------- 解析 ----------

/** 解析结果：key 同时是 KeyboardEvent.code 与 Monaco KeyCode 枚举名（如 KeyD / Digit1 / Slash / F10） */
export interface ParsedBinding {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const SYMBOL_KEYS: Record<string, string> = {
  "/": "Slash",
  "\\": "Backslash",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

const NAMED_KEYS = [
  "Enter", "Tab", "Space", "Backspace", "Delete", "Insert", "Escape",
  "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
];

/**
 * 方位键短名 → 标准 code（P1：导航历史 Ctrl+Alt+Left/Right 用）。
 * `KeyboardEvent.code` 只有 `ArrowLeft` 形态，但用户（与 PyCharm 键位表）习惯写 `Left`，
 * 故在**解析层**归一，而不是让每个调用方各写一遍映射。
 */
const NAMED_KEY_ALIASES: Record<string, string> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
};

/** 单个键名 → 标准 key 码；非法返回 null */
export function parseKeyToken(token: string): string | null {
  if (/^[A-Za-z]$/.test(token)) return "Key" + token.toUpperCase();
  if (/^[0-9]$/.test(token)) return "Digit" + token;
  const f = /^F([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (f) return "F" + f[1];
  const sym = SYMBOL_KEYS[token];
  if (sym) return sym;
  const lower = token.toLowerCase();
  const alias = NAMED_KEY_ALIASES[lower];
  if (alias) return alias;
  const named = NAMED_KEYS.find((n) => n.toLowerCase() === lower);
  return named ?? null;
}

/**
 * `KeyboardEvent.code` → 键位串里的键 token（`parseKeyToken` 的反向，用于设置面板「按键录入」）。
 * 例：KeyS → S、Digit0 → 0、Slash → /、F10 → F10、ArrowLeft → ArrowLeft。
 * 无法用键位串表达的键（Numpad*、CapsLock、纯修饰键 ControlLeft 等）返回 null。
 */
export function codeToKeyToken(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NAMED_KEYS.includes(code)) return code;
  for (const [sym, c] of Object.entries(SYMBOL_KEYS)) if (c === code) return sym;
  return null;
}

/** 事件当前按下的修饰键（规范序 Ctrl → Shift → Alt）；Ctrl 与 Cmd 同归一为 Ctrl（与 eventMatches 一致） */
export function modsFromEvent(e: KeyboardEvent): string[] {
  return [(e.ctrlKey || e.metaKey ? "Ctrl" : ""), e.shiftKey ? "Shift" : "", e.altKey ? "Alt" : ""].filter(Boolean);
}

/** 键盘事件 → 键位串（如 "Ctrl+0"）；未成键（纯修饰键 / 不支持的键）返回 null */
export function chordFromEvent(e: KeyboardEvent): string | null {
  const token = codeToKeyToken(e.code);
  if (!token) return null;
  return [...modsFromEvent(e), token].join("+");
}

/** 解析 "Ctrl+Shift+F" 形式的键位串；空串 / 非法格式 / 未知键名返回 null */
export function parseBinding(raw: string): ParsedBinding | null {
  const tokens = raw.split("+").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  let ctrl = false;
  let shift = false;
  let alt = false;
  for (const t of tokens.slice(0, -1)) {
    const k = t.toLowerCase();
    if (k === "ctrl" || k === "control") ctrl = true;
    else if (k === "shift") shift = true;
    else if (k === "alt") alt = true;
    else return null; // 修饰键位置出现非修饰词（如 "Ctrl+X+Y"）
  }
  const key = parseKeyToken(tokens[tokens.length - 1]);
  if (!key) return null;
  return { ctrl, shift, alt, key };
}

/** 归一化（修饰键固定序 + key 码），用于冲突检测；非法返回 null */
export function normalizeBinding(raw: string): string | null {
  const p = parseBinding(raw);
  if (!p) return null;
  const mods = [p.ctrl ? "Ctrl" : "", p.shift ? "Shift" : "", p.alt ? "Alt" : ""].filter(Boolean);
  return [...mods, p.key].join("+");
}

// ---------- 校验 ----------

/** 校验键位表：各键可解析、互不冲突；返回错误消息，null = 通过 */
export function validateKeybindingMap(map: Record<string, string>): string | null {
  const seen = new Map<string, string>();
  for (const m of KEYBINDING_META) {
    const raw = (map[m.id] ?? "").trim();
    if (!raw) continue; // 空 = 解绑，合法
    if (!parseBinding(raw)) return t("ide.kb.invalidFormat", { label: m.label, raw });
    const norm = normalizeBinding(raw);
    if (!norm) return t("ide.kb.invalidFormat", { label: m.label, raw });
    const dup = seen.get(norm);
    if (dup) return t("ide.kb.conflict", { label: m.label, dup, norm });
    seen.set(norm, m.label);
  }
  return null;
}

// ---------- window 级匹配 ----------

/** 按键事件是否匹配给定解析结果（Ctrl 兼容 Cmd） */
export function eventMatches(e: KeyboardEvent, p: ParsedBinding): boolean {
  return (
    e.code === p.key &&
    (e.ctrlKey || e.metaKey) === p.ctrl &&
    e.shiftKey === p.shift &&
    e.altKey === p.alt
  );
}

/** 从 window 级快捷键中找出与事件匹配的项；无匹配返回 null（实时读设置，改键即生效） */
export function matchWindowBinding(e: KeyboardEvent): KeybindingId | null {
  for (const m of KEYBINDING_META) {
    if (m.scope !== "window") continue;
    const raw = (app.settings.keybindings[m.id] ?? "").trim();
    if (!raw) continue;
    const p = parseBinding(raw);
    if (p && eventMatches(e, p)) return m.id;
  }
  return null;
}

/** 当前键位显示文本（菜单标签用；解绑时返回空串） */
export function bindingLabel(id: KeybindingId): string {
  return (app.settings.keybindings[id] ?? "").trim();
}

/** 修饰键的规范显示形（用户可能写成 control/CTRL 等，显示时统一） */
const MOD_DISPLAY: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
};

/** 键位串 → 逐段显示 token（"Ctrl+Shift+F" → ["Ctrl","Shift","F"]），供 <kbd> 分段渲染（UI-25 欢迎页）。
 *  与 tooltip 的 data-tip-key 分工不同：那里是整串一个 kbd 框（浮层空间紧张），这里是每段一个框。
 *  规则：修饰键按 MOD_DISPLAY 归一大小写；末位单字母/数字转大写（用户写 "ctrl+s" 也显示 "S"）；
 *  其余功能键/符号原样保留（F10、Slash 等由用户自己写）。
 *  无法解析的串（parseBinding 判非法，如 "Ctrl+X+Y"）整串作一段返回——不猜拆法，也不丢信息。
 *  空串返回 []（调用方据此显示「未绑定」占位，而不是渲染一个空 kbd 框）。 */
export function bindingChord(raw: string): string[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  const tokens = s.split("+").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  if (!parseBinding(s)) return [s];
  const last = tokens.length - 1;
  return tokens.map((t, i) => {
    const mod = MOD_DISPLAY[t.toLowerCase()];
    if (mod) return mod;
    if (i === last && t.length === 1) return t.toUpperCase(); // 末位主键：单字符统一大写
    return t;
  });
}

// ---------- editor 级命令与映射 ----------

const COMMAND_PREFIX = "pylume.kb.";
const handlers = new Map<KeybindingId, () => void>();
let commandsRegistered = false;
let rulesDisposable: MonacoApi.IDisposable | null = null;

/** 设置/替换某快捷键命令的实际处理函数（可多次调用，后设者生效） */
export function setKeybindingHandler(id: KeybindingId, fn: () => void): void {
  handlers.set(id, fn);
}

/** 外部入口（命令面板等）复用同一 handler：与键位触发共享实现，杜绝两处漂移（PR-E review 建议 5）。
 *  handler 未注册（initKeybindingCommands 未跑/该键无 handler）时静默返回。 */
export function triggerEditorKeybindingAction(id: KeybindingId): void {
  handlers.get(id)?.();
}

/** 复制当前行（空选区）或选区覆盖的行（PyCharm Ctrl+D 语义），光标位置不变 */
function duplicateCurrentLine(): void {
  const editor = app.editor;
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;
  const lines: string[] = [];
  for (let l = sel.startLineNumber; l <= sel.endLineNumber; l++) {
    lines.push(model.getLineContent(l));
  }
  const endLine = sel.endLineNumber;
  const endCol = model.getLineMaxColumn(endLine);
  editor.executeEdits("pylume-duplicate", [
    {
      range: new app.monaco.Range(endLine, endCol, endLine, endCol),
      text: "\n" + lines.join("\n"),
    },
  ]);
}

/** 一次性注册 editor 级稳定命令（幂等）；键 → 命令映射由 applyEditorKeybindings 建立 */
export function initKeybindingCommands(monaco: MonacoModule): void {
  if (commandsRegistered) return;
  commandsRegistered = true;
  setKeybindingHandler("duplicate_line", duplicateCurrentLine);
  setKeybindingHandler("comment_line", () => {
    app.editor.trigger("keybindings", "editor.action.commentLine", null);
  });
  setKeybindingHandler("comment_block", () => {
    app.editor.trigger("keybindings", "editor.action.blockComment", null);
  });
  // P1（C-1）：语法感知选区扩展/收缩（Monaco smartSelect contrib，命令 id 见 monaco.ts 注释）
  setKeybindingHandler("smart_select_expand", () => {
    app.editor.trigger("keybindings", "editor.action.smartSelect.expand", null);
  });
  setKeybindingHandler("smart_select_shrink", () => {
    app.editor.trigger("keybindings", "editor.action.smartSelect.shrink", null);
  });
  // P1（C-2）：行/选区上下移动（Monaco linesOperations contrib，自动修正缩进）
  setKeybindingHandler("move_line_up", () => {
    app.editor.trigger("keybindings", "editor.action.moveLinesUpAction", null);
  });
  // P4（C-3）：列（矩形）选择开关。Monaco 0.52 中列选择是核心 editor option
  // （columnSelection，无独立 contrib/命令），开启后鼠标拖拽/Shift+点击按矩形选择；
  // Alt+Shift+方向键的列向扩展不受此开关影响（内建行为）。
  setKeybindingHandler("toggle_column_selection", () => {
    const ed = app.editor;
    const on = !ed.getOption(app.monaco.editor.EditorOption.columnSelection);
    ed.updateOptions({ columnSelection: on });
    // G-3：模式切换必须可见——否则用户忘记开过列选择，会把矩形选中当成 bug
    toast(on ? t("ide.kb.columnSelectOn") : t("ide.kb.columnSelectOff"), on ? "success" : "info");
  });
  // P4（C-4）：向右分屏（splitEditor.ts 钉住式双编辑器）
  setKeybindingHandler("split_editor", () => toggleSplit());
  setKeybindingHandler("move_line_down", () => {
    app.editor.trigger("keybindings", "editor.action.moveLinesDownAction", null);
  });
  // PR-A（dx_features_backlog §6.1）：键位补齐组。命令 id 实测自 Monaco 0.52.2：
  // 折叠族注册为 "editor.foldAll"/"editor.unfoldAll"（无 .action 前缀），deleteLines/jumpToBracket 带 .action
  setKeybindingHandler("delete_line", () => {
    app.editor.trigger("keybindings", "editor.action.deleteLines", null);
  });
  setKeybindingHandler("fold_all", () => {
    app.editor.trigger("keybindings", "editor.foldAll", null);
  });
  setKeybindingHandler("unfold_all", () => {
    app.editor.trigger("keybindings", "editor.unfoldAll", null);
  });
  setKeybindingHandler("jump_to_bracket", () => {
    app.editor.trigger("keybindings", "editor.action.jumpToBracket", null);
  });
  // PR-J（dx_features_backlog §6.6）：触发补全建议的备选键（Alt+/）。Ctrl+Space 是 Monaco 内建
  // 固定键且被 Windows 中文 IME 吞键（人工验证），此处注册可配置的保底入口；Monaco 0.52 命令 id
  // 为 "editor.action.triggerSuggest"（带 .action 前缀，同 deleteLines 家族）
  setKeybindingHandler("trigger_suggest", () => {
    app.editor.trigger("keybindings", "editor.action.triggerSuggest", null);
  });
  // 诊断导航（PyCharm 同款 F8 / Shift+F8）：下一个 / 上一个 error/warning marker（循环回绕）
  setKeybindingHandler("goto_next_problem", () => gotoMarker(1));
  setKeybindingHandler("goto_prev_problem", () => gotoMarker(-1));
  for (const m of KEYBINDING_META) {
    if (m.scope !== "editor") continue;
    monaco.editor.addCommand({
      id: COMMAND_PREFIX + m.id,
      run: () => handlers.get(m.id)?.(),
    });
  }
}

/**
 * `KeyboardEvent.code` 形态 → Monaco `KeyCode` 枚举名（P1：移动行 Ctrl+Shift+↑/↓ 暴露的坑）。
 * Monaco 的方位键枚举叫 `UpArrow`/`DownArrow`/`LeftArrow`/`RightArrow`（没有 `Arrow*` 前缀），
 * 直接拿解析结果去查表会得到 undefined → 规则被静默跳过、键位看似没生效。
 * 此前方位键只用于 window 级键位（不经此函数），故一直没暴露。
 */
const MONACO_KEY_ALIASES: Record<string, string> = {
  ArrowUp: "UpArrow",
  ArrowDown: "DownArrow",
  ArrowLeft: "LeftArrow",
  ArrowRight: "RightArrow",
};

/** ParsedBinding → Monaco keybinding 数值；未知键返回 null */
export function toMonacoKeybinding(monaco: MonacoModule, p: ParsedBinding): number | null {
  const name = MONACO_KEY_ALIASES[p.key] ?? p.key;
  const code = (monaco.KeyCode as unknown as Record<string, number | undefined>)[name];
  if (code === undefined) return null;
  let kb = code;
  if (p.ctrl) kb |= monaco.KeyMod.CtrlCmd;
  if (p.shift) kb |= monaco.KeyMod.Shift;
  if (p.alt) kb |= monaco.KeyMod.Alt;
  return kb;
}

/** 按当前设置（重新）建立 editor 级键 → 命令映射；初始化与设置保存后调用 */
export function applyEditorKeybindings(): void {
  const monaco = app.monaco;
  rulesDisposable?.dispose();
  rulesDisposable = null;
  const rules: MonacoApi.editor.IKeybindingRule[] = [];
  for (const m of KEYBINDING_META) {
    if (m.scope !== "editor") continue;
    const raw = (app.settings.keybindings[m.id] ?? "").trim();
    if (!raw) continue; // 解绑：不注册（Monaco 内建同键行为可能恢复，属预期）
    const p = parseBinding(raw);
    if (!p) continue;
    const kb = toMonacoKeybinding(monaco, p);
    if (kb === null) continue;
    rules.push({ keybinding: kb, command: COMMAND_PREFIX + m.id, when: "editorTextFocus" });
  }
  if (rules.length > 0) rulesDisposable = monaco.editor.addKeybindingRules(rules);
}
