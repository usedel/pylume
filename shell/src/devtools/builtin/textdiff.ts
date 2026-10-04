// 文本 Diff 工具（v1.1 · 文本类）：两栏输入 → 行级 LCS diff（+/-/= 前缀渲染）。

import type { PanelHost } from "../../extensions/facade";
import { flashError } from "../feedback";
import { diffLines, formatDiff } from "./textfns";
import { t } from "../../i18n";

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const aInput = kit.textarea({ placeholder: t("devtools.diff.aPh") });
  const bInput = kit.textarea({ placeholder: t("devtools.diff.bPh") });
  const errEl = kit.errorSlot();

  const run = (): void => {
    try {
      out.set(formatDiff(diffLines(aInput.value, bInput.value)));
      errEl.textContent = "";
    } catch (e) {
      errEl.textContent = e instanceof Error ? e.message : String(e);
      flashError(runBtn, t("devtools.common.failed"));
    }
  };
  const runBtn = kit.primaryButton(t("devtools.diff.run"), "diff", run);

  const out = kit.output({ language: "plaintext", placeholder: t("devtools.diff.outPh") });
  wrap.append(
    kit.row(aInput, bInput),
    kit.toolbar(runBtn, "spacer", kit.copyButton(() => out.get())),
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
