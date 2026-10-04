// 大小写/命名风格转换工具（v1.1 · 文本类）：upper / lower / title / snake / camel 五模式。

import type { PanelHost } from "../../extensions/facade";
import { transformCase, type CaseMode } from "./textfns";
import { t } from "../../i18n";

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const input = kit.textarea({ placeholder: t("devtools.caseconvert.inputPh"), flex: true });

  const modeGroup = kit.radioGroup<CaseMode>({
    label: t("devtools.caseconvert.mode"),
    options: [
      { value: "upper", label: t("devtools.common.uppercase") },
      { value: "lower", label: t("devtools.caseconvert.lower") },
      { value: "title", label: t("devtools.caseconvert.title") },
      { value: "snake", label: "snake_case" },
      { value: "camel", label: "camelCase" },
    ],
    value: "upper",
  });

  const run = (): void => {
    out.set(transformCase(input.value, modeGroup.get()));
  };
  const runBtn = kit.primaryButton(t("devtools.common.convert"), "case-sensitive", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
  });

  const out = kit.output({ language: "plaintext", placeholder: t("devtools.common.resultPlaceholder") });
  wrap.append(
    input,
    kit.toolbar(modeGroup.el, runBtn, "spacer", kit.copyButton(() => out.get())),
    out.el,
  );
  host.root.appendChild(wrap);
  return {
    dispose() {
      out.dispose();
    },
  };
}

/** inline：选区 → 大写（其余模式请用面板） */
export function upperSelection(text: string): string {
  return transformCase(text, "upper");
}
