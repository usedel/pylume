// JSON 美化/压缩工具（PR-3 内置插件 · 格式化类）：可编辑 Monaco 输入 + 只读输出，缩进单选。

import type { PanelHost } from "../../extensions/facade";
import { flashError } from "../feedback";
import { t } from "../../i18n";

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const input = kit.output({ language: "json", readOnly: false, placeholder: t("devtools.common.pasteJsonPh") });
  const errEl = kit.errorSlot();

  // 缩进互斥选择：单选组（2 / 4 空格二选一）
  const indentGroup = kit.radioGroup<"2" | "4">({
    label: t("devtools.jsonfmt.indent"),
    options: [
      { value: "2", label: t("devtools.jsonfmt.indent2") },
      { value: "4", label: t("devtools.jsonfmt.indent4") },
    ],
    value: "2",
  });

  const runBtn = kit.primaryButton(t("devtools.jsonfmt.beautify"), "check", () => run("beautify"));
  const minifyBtn = kit.button(t("devtools.jsonfmt.minify"), "collapse-all", () => run("minify"));

  const run = (mode: "beautify" | "minify"): void => {
    const text = input.get().trim();
    if (!text) {
      errEl.textContent = t("devtools.jsonfmt.needInput");
      return;
    }
    try {
      const v = JSON.parse(text);
      out.set(mode === "beautify" ? JSON.stringify(v, null, Number(indentGroup.get())) : JSON.stringify(v));
      errEl.textContent = "";
    } catch (e) {
      errEl.textContent = t("devtools.common.jsonParseFailed", { msg: e instanceof Error ? e.message : String(e) });
      flashError(runBtn, t("devtools.common.failed"));
    }
  };

  const out = kit.output({ language: "json", placeholder: t("devtools.common.resultPlaceholder") });
  wrap.append(
    input.el,
    kit.toolbar(indentGroup.el, runBtn, minifyBtn, "spacer", kit.copyButton(() => out.get())),
    errEl,
    out.el,
  );
  host.root.appendChild(wrap);
  // input 与 out 均为 kit.output（Monaco 实例），须随工具实例释放（R-5 复测发现的泄漏）
  return {
    dispose() {
      input.dispose();
      out.dispose();
    },
  };
}
