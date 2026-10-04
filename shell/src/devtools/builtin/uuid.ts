// UUID 生成工具（PR-3 内置插件 · 生成类）：批量生成 v4 + 复制/插入编辑器。

import type { PanelHost } from "../../extensions/facade";
import { flashError, flashSuccess } from "../feedback";
import { uuidV4 } from "./pure";
import { t } from "../../i18n";

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const errEl = kit.errorSlot();

  const gen = (): void => {
    const n = Number(countInput.value) || 1;
    const capped = Math.min(Math.max(1, n), 100);
    const lines: string[] = [];
    for (let i = 0; i < capped; i++) lines.push(uuidV4());
    out.set(lines.join("\n"));
  };

  const countLabel = document.createElement("span");
  countLabel.className = "tool-label";
  countLabel.textContent = t("devtools.uuid.countLabel");
  const countInput = kit.input({ type: "number", onEnter: () => gen() });
  countInput.classList.add("uuid-count");
  countInput.value = "1";
  const genBtn = kit.primaryButton(t("devtools.common.generate"), "add", gen);

  const insertBtn = kit.button(t("devtools.common.insertEditor"), "export");
  insertBtn.dataset.tip = t("devtools.common.insertEditorTip");
  insertBtn.addEventListener("click", () => {
    const ok = host.insertToEditor(out.get());
    if (ok) flashSuccess(insertBtn, t("devtools.common.inserted"));
    else flashError(insertBtn, t("devtools.common.noFileOpen")); // 修复：此前无失败反馈
  });

  const out = kit.output({ language: "plaintext", placeholder: t("devtools.uuid.outPh") });
  wrap.append(
    kit.row(countLabel, countInput, genBtn),
    kit.toolbar("spacer", kit.copyButton(() => out.get()), insertBtn),
    errEl,
    out.el,
  );
  host.root.appendChild(wrap);
  gen(); // 首屏先生成一个
  // kit.output 持有 Monaco 实例，须随工具实例释放（R-5 复测发现的泄漏）
  return {
    dispose() {
      out.dispose();
    },
  };
}
