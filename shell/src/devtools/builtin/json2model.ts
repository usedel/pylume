// JSON → Python 模型工具（P1 · 库支持 §7-2 内置插件 · 生成类）：
// 粘贴 JSON → 实时生成 Pydantic / dataclass / TypedDict 模型类。纯前端零求值（转换全程本地）。
// 形态选择用 kit.radioGroup（互斥单选组，与 base64 的方向选择同一范式）；转换逻辑在 json2model.gen.ts。

import type { PanelHost } from "../../extensions/facade";
import { jsonToModelCode } from "./json2model.gen";
import { t } from "../../i18n";

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const input = kit.textarea({ placeholder: t("devtools.j2m.inputPh"), flex: true, rows: 8 });
  const nameInput = kit.input({ placeholder: t("devtools.j2m.rootNamePh"), onInput: run });
  const errEl = kit.errorSlot();
  const out = kit.output({ language: "python", placeholder: t("devtools.j2m.outPh") });

  const style = kit.radioGroup<"pydantic" | "dataclass" | "typeddict">({
    label: t("devtools.j2m.style"),
    options: [
      { value: "pydantic", label: "Pydantic" },
      { value: "dataclass", label: "dataclass" },
      { value: "typeddict", label: "TypedDict" },
    ],
    value: "pydantic",
    onChange: run,
  });

  function run(): void {
    const text = input.value;
    if (!text.trim()) {
      out.clear();
      errEl.textContent = "";
      return;
    }
    try {
      out.set(jsonToModelCode(text, { style: style.get(), rootName: nameInput.value }));
      errEl.textContent = "";
    } catch (e) {
      errEl.textContent = t("devtools.common.jsonParseFailed", { msg: e instanceof Error ? e.message : String(e) });
    }
  }

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
  });

  wrap.append(
    input,
    kit.toolbar(style.el, nameInput, "spacer", kit.pasteButton((t) => { input.value = t; run(); }), kit.copyButton(() => out.get())),
    errEl,
    out.el,
  );
  host.root.appendChild(wrap);
  // kit.output 持有 Monaco 实例，须随工具实例释放（R-5 复测发现的泄漏）
  return {
    dispose() {
      out.dispose();
    },
  };
}
