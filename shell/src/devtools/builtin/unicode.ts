// Unicode ⇄ 明文工具（v1.1 · 转换类）：明文 → \uXXXX 转义 / 转义 → 明文。
// escape 形态对齐 Python repr（BMP 外拆代理对）；unescape 兼容 \uXXXX / 代理对 / \UXXXXXXXX / \u{...}。

import type { PanelHost } from "../../extensions/facade";
import { flashError } from "../feedback";
import { unicodeEscape, unicodeUnescape } from "./textfns";
import { t } from "../../i18n";

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const input = kit.textarea({ placeholder: t("devtools.uni.inputPh"), flex: true });
  const errEl = kit.errorSlot();

  const dirGroup = kit.radioGroup<"escape" | "unescape">({
    label: t("devtools.common.direction"),
    options: [
      { value: "escape", label: t("devtools.uni.escape") },
      { value: "unescape", label: t("devtools.uni.unescape") },
    ],
    value: "escape",
  });

  const run = (): void => {
    const text = input.value;
    if (!text.trim()) {
      errEl.textContent = t("devtools.common.needInput");
      return;
    }
    try {
      out.set(dirGroup.get() === "escape" ? unicodeEscape(text) : unicodeUnescape(text));
      errEl.textContent = "";
    } catch (e) {
      errEl.textContent = t("devtools.common.convertFailed", { msg: e instanceof Error ? e.message : String(e) });
      flashError(runBtn, t("devtools.common.failed"));
    }
  };

  const runBtn = kit.primaryButton(t("devtools.common.convert"), "play", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
  });

  const out = kit.output({ language: "plaintext", placeholder: t("devtools.common.resultPlaceholder") });
  wrap.append(
    input,
    kit.toolbar(dirGroup.el, runBtn, "spacer", kit.copyButton(() => out.get())),
    errEl,
    out.el,
  );
  host.root.appendChild(wrap);
  return {
    dispose() {
      out.dispose();
    },
  };
}

/** inline：选区 Unicode 转义 → 明文 */
export function unescapeSelection(text: string): string {
  return unicodeUnescape(text);
}
