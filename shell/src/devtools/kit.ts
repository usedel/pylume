// ToolKit：工具 UI 积木（plugin_system_design §9.12）。
// 目标：工具只写逻辑，不手写 DOM 样板——textarea/输出/工具栏/按钮/复制/粘贴/清空/错误提示
// 统一由 kit 构造，并兜底项目规范（autocomplete=off + spellcheck=false、.btn 体系、
// Monaco 跟随用户字号/字体族/减少动画、flash 反馈、权限相关的友好降级）。
//
// 设计取舍：kit 依赖 host（copy/paste 需要 host 的剪贴板能力），故以 createToolKit(host)
// 工厂构造，不导出全局单例；工具实例随挂载新建、卸载即销毁（与 UI-11/UI-29 同一裁决）。

import { codicon } from "../util";
import { app } from "../state";
import { motionDisabled } from "../anim"; // UI-11：只读预览的光标闪烁也随「减少动画」
import { flashError, flashSuccess } from "./feedback";
import type { MonacoModule, ToolHost } from "./types";
import { t } from "../i18n";

// ---------- 选项类型 ----------

export interface TextareaOpts {
  placeholder?: string;
  /** 等宽字体（默认 true） */
  mono?: boolean;
  rows?: number;
  /** true = 纵向撑满剩余空间（flex:1 + min-height:0） */
  flex?: boolean;
  onInput?: (v: string) => void;
}

export interface InputOpts {
  placeholder?: string;
  type?: "text" | "number";
  readOnly?: boolean;
  onInput?: (v: string) => void;
  /** Enter 键回调 */
  onEnter?: (v: string) => void;
}

export interface OutputOpts {
  language?: string;
  /** 默认 true；false = 可编辑（JSON 美化的输入区等） */
  readOnly?: boolean;
  /** 初始提示文本（placeholder 模式，写入后清空） */
  placeholder?: string;
}

/** Monaco 封装：el 挂载点 + 读写 + 生命周期 */
export interface ToolOutput {
  el: HTMLElement;
  get(): string;
  set(text: string): void;
  clear(): void;
  dispose(): void;
}

export type ClearTarget = HTMLTextAreaElement | HTMLInputElement | ToolOutput;

// ---------- 工具箱 ----------

export interface ToolKit {
  /** .tool-body 根容器（flex column + gap） */
  body(): HTMLElement;
  /** 横向行；"spacer" 占位元素撑开 */
  row(...els: (HTMLElement | "spacer")[]): HTMLElement;
  /** .tool-toolbar 工具栏 */
  toolbar(...items: (HTMLElement | "spacer")[]): HTMLElement;
  /** codicon 图标 span（树节点/徽标等小图标） */
  icon(name: string): HTMLElement;
  /**
   * 互斥单选组（WAI-ARIA radiogroup，对齐 themePicker 范式）：
   * role=radio + aria-checked 单一真源 + 漫游 tabindex（组内一个 tab stop），
   * ←→↑↓ 移动即选中。值读经返回的 group.get()。
   * 适用：方向（编码/解码）、算法（MD5/SHA-256）、缩进（2/4 空格）等二选一互斥项——
   * 比「两个 .active 按钮」更能传达「这是一组互斥选择」的语义。
   */
  radioGroup<T extends string>(opts: RadioGroupOpts<T>): ToolRadioGroup<T>;
  textarea(opts?: TextareaOpts): HTMLTextAreaElement;
  input(opts?: InputOpts): HTMLInputElement;
  /** Monaco 输出封装（自动跟随字号/字体族/减少动画；dispose 随工具实例释放） */
  output(opts?: OutputOpts): ToolOutput;
  button(label: string, icon?: string, onClick?: (ev: MouseEvent) => void): HTMLButtonElement;
  primaryButton(label: string, icon?: string, onClick?: (ev: MouseEvent) => void): HTMLButtonElement;
  /** 图标按钮（data-tip + aria-label；永不 disabled，对齐 UI-09 判定规则） */
  iconButton(icon: string, tip: string, onClick?: (ev: MouseEvent) => void): HTMLButtonElement;
  /** 复制按钮：内置 flash 反馈；无文本时 flash「无内容」 */
  copyButton(getText: () => string): HTMLButtonElement;
  /** 粘贴按钮：读取剪贴板写入 setText；读失败 flash「读取失败」 */
  pasteButton(setText: (t: string) => void): HTMLButtonElement;
  /** 清空按钮：清空所有目标的值 */
  clearButton(...targets: ClearTarget[]): HTMLButtonElement;
  /** .tool-error 错误提示槽（min-height 占位） */
  errorSlot(): HTMLElement;
  /** 按钮 flash 反馈（转发 feedback.ts） */
  flash(btn: HTMLButtonElement, kind: "ok" | "error", text: string): void;
}

/** 单选组选项 */
export interface RadioGroupOpts<T extends string> {
  /** 读屏可访问名称（如「转换方向」） */
  label: string;
  /** 选项：值 + 显示名 */
  options: ReadonlyArray<{ value: T; label: string }>;
  /** 初始选中值 */
  value: T;
  /** 选中变化回调（可选——多数工具读 get() 即可） */
  onChange?: (value: T) => void;
}

/** 单选组句柄 */
export interface ToolRadioGroup<T extends string> {
  /** 组容器（挂进布局） */
  el: HTMLElement;
  /** 当前选中值（读 aria-checked 单一真源） */
  get(): T;
}

/** 绑定 host 构造 kit（copy/paste/output 依赖 host 能力）。
 *  monaco 参数（PR-3）：插件工具可能无 monaco 权限——kit.output 的 Monaco 封装自带运行时，
 *  与门控的 host.monaco 解耦（facade 构造 kit 时显式传入；缺省回退 host.monaco）。 */
export function createToolKit(host: ToolHost, monacoOverride?: MonacoModule): ToolKit {
  const monaco = monacoOverride ?? host.monaco;

  function baseButton(cls: string, label: string, icon?: string, onClick?: (ev: MouseEvent) => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = cls;
    if (icon) btn.appendChild(codicon(icon));
    btn.append(label); // 间距由 .btn 的 gap 提供
    if (onClick) btn.addEventListener("click", onClick);
    return btn;
  }

  function makeOutput(opts: OutputOpts): ToolOutput {
    const el = document.createElement("div");
    el.className = "tool-output";
    const fontFamily = app.settings.font_family.trim();
    const editor = monaco.editor.create(el, {
      value: opts.placeholder ?? "",
      language: opts.language ?? "plaintext",
      readOnly: opts.readOnly !== false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: app.settings.font_size,
      ...(fontFamily ? { fontFamily } : {}),
      scrollBeyondLastLine: false,
      wordWrap: "on",
      // UI-11：实例随工具挂载新建、卸载即销毁，创建时读一次开关即可
      cursorBlinking: motionDisabled() ? "solid" : "blink",
    });
    return {
      el,
      get: () => editor.getValue(),
      set: (text: string) => editor.setValue(text),
      clear: () => editor.setValue(""),
      dispose: () => editor.dispose(),
    };
  }

  return {
    body(): HTMLElement {
      const el = document.createElement("div");
      el.className = "tool-body";
      return el;
    },

    row(...els): HTMLElement {
      const el = document.createElement("div");
      el.className = "tool-row";
      for (const c of els) el.appendChild(c === "spacer" ? makeSpacer() : c);
      return el;
    },

    toolbar(...items): HTMLElement {
      const el = document.createElement("div");
      el.className = "tool-toolbar";
      for (const c of items) el.appendChild(c === "spacer" ? makeSpacer() : c);
      return el;
    },

    icon(name: string): HTMLElement {
      return codicon(name);
    },

    radioGroup<T extends string>(opts: RadioGroupOpts<T>): ToolRadioGroup<T> {
      const MOVE: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      const root = document.createElement("div");
      root.className = "tool-radiogroup";
      root.setAttribute("role", "radiogroup");
      root.setAttribute("aria-label", opts.label);

      const radios: HTMLButtonElement[] = opts.options.map((o) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tool-radio";
        btn.dataset.value = o.value;
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-checked", "false");
        btn.tabIndex = -1;
        // 勾选指示点：CSS 按 aria-checked 切可见（占位常驻，等宽不跳动）
        btn.appendChild(Object.assign(document.createElement("span"), { className: "tool-radio-dot" }));
        const text = document.createElement("span");
        text.className = "tool-radio-text";
        text.textContent = o.label;
        btn.appendChild(text);
        btn.addEventListener("click", () => select(o.value, true));
        root.appendChild(btn);
        return btn;
      });

      const select = (value: T, byUser: boolean): void => {
        for (const r of radios) {
          const sel = r.dataset.value === value;
          r.setAttribute("aria-checked", String(sel));
          r.tabIndex = sel ? 0 : -1; // 漫游 tabindex：组内仅选中项可 Tab
        }
        if (byUser) opts.onChange?.(value);
      };
      select(opts.value, false);

      // 方向键移动即选中（radiogroup 惯例；Space/Enter 走 button 原生激活）
      root.addEventListener("keydown", (e) => {
        const step = MOVE[e.key];
        if (!step) return;
        e.preventDefault();
        const cur = radios.findIndex((r) => r.getAttribute("aria-checked") === "true");
        const next = (cur + step + radios.length) % radios.length;
        select(radios[next].dataset.value as T, true);
        radios[next].focus();
      });

      return {
        el: root,
        get: (): T => {
          const hit = radios.find((r) => r.getAttribute("aria-checked") === "true");
          return (hit?.dataset.value ?? opts.options[0].value) as T;
        },
      };
    },

    textarea(opts = {}): HTMLTextAreaElement {
      const el = document.createElement("textarea");
      el.className = "tool-textarea";
      if (opts.flex) el.classList.add("tool-textarea--flex");
      if (opts.rows !== undefined) el.rows = opts.rows;
      if (opts.placeholder) el.placeholder = opts.placeholder;
      el.spellcheck = false;
      el.autocomplete = "off";
      if (opts.onInput) el.addEventListener("input", () => opts.onInput!(el.value));
      return el;
    },

    input(opts = {}): HTMLInputElement {
      const el = document.createElement("input");
      el.className = "tool-input";
      el.type = opts.type ?? "text";
      if (opts.placeholder) el.placeholder = opts.placeholder;
      if (opts.readOnly) el.readOnly = true;
      el.spellcheck = false;
      el.autocomplete = "off";
      if (opts.onInput) el.addEventListener("input", () => opts.onInput!(el.value));
      if (opts.onEnter) {
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            opts.onEnter!(el.value);
          }
        });
      }
      return el;
    },

    output: makeOutput,

    button: (label, icon, onClick) => baseButton("btn", label, icon, onClick),
    primaryButton: (label, icon, onClick) => baseButton("btn btn--primary", label, icon, onClick),

    iconButton(icon, tip, onClick): HTMLButtonElement {
      const btn = document.createElement("button");
      btn.className = "btn btn--icon";
      // UI-09：图标按钮永不 disabled，data-tip + aria-label 双补
      btn.dataset.tip = tip;
      btn.setAttribute("aria-label", tip);
      btn.appendChild(codicon(icon));
      if (onClick) btn.addEventListener("click", onClick);
      return btn;
    },

    copyButton(getText: () => string): HTMLButtonElement {
      const btn = baseButton("btn", t("devtools.common.copy"), "copy");
      btn.addEventListener("click", () => {
        const text = getText();
        if (!text) {
          flashError(btn, t("devtools.common.noContent"));
          return;
        }
        void host.copyToClipboard(text).then((ok) => {
          if (ok) flashSuccess(btn, t("devtools.common.copied"));
          else flashError(btn, t("devtools.common.copyFailed"));
        });
      });
      return btn;
    },

    pasteButton(setText: (t: string) => void): HTMLButtonElement {
      const btn = baseButton("btn", t("devtools.common.paste"), "clippy");
      btn.addEventListener("click", () => {
        void host.readClipboard().then((text) => {
          if (text !== null && text !== "") {
            setText(text);
            flashSuccess(btn, t("devtools.common.pasted"));
          } else {
            flashError(btn, t("devtools.common.clipboardEmpty"));
          }
        });
      });
      return btn;
    },

    clearButton(...targets: ClearTarget[]): HTMLButtonElement {
      const btn = baseButton("btn", t("devtools.common.clear"), "clear-all");
      btn.addEventListener("click", () => {
        for (const t of targets) {
          if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) t.value = "";
          else t.clear();
        }
      });
      return btn;
    },

    errorSlot(): HTMLElement {
      const el = document.createElement("div");
      el.className = "tool-error";
      return el;
    },

    flash(btn, kind, text): void {
      if (kind === "ok") flashSuccess(btn, text);
      else flashError(btn, text);
    },
  };
}

function makeSpacer(): HTMLElement {
  const el = document.createElement("span");
  el.className = "spacer";
  return el;
}
