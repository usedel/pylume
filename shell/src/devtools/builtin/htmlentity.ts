// HTML 实体编码/解码工具（v1.1 · 编码类）：双向互转 + inline 编码。

import type { PanelHost } from "../../extensions/facade";
import { flashError } from "../feedback";
import { htmlDecode, htmlEncode } from "./textfns";
import { t } from "../../i18n";

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const input = kit.textarea({ placeholder: t("devtools.htmlentity.inputPh"), flex: true });
  const errEl = kit.errorSlot();

  const dirGroup = kit.radioGroup<"encode" | "decode">({
    label: t("devtools.common.direction"),
    options: [
      { value: "encode", label: t("devtools.common.encode") },
      { value: "decode", label: t("devtools.common.decode") },
    ],
    value: "encode",
  });

  const run = (): void => {
    const text = input.value;
    if (!text.trim()) {
      errEl.textContent = t("devtools.common.needInput");
      return;
    }
    try {
      out.set(dirGroup.get() === "encode" ? htmlEncode(text) : htmlDecode(text));
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

/** inline：选区 → HTML 实体编码 */
export function encodeSelection(text: string): string {
  return htmlEncode(text);
}
