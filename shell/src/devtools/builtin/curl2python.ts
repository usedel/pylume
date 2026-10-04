// cURL ⇄ Python 工具（PR-3 迁移为内置插件形态；P1 §7-5 扩为双向）：
// 输入 curl 命令 → requests 代码（curl2python/ 纯函数）；
// 输入 Python requests/httpx 代码 → cURL 命令（python2curl.gen.ts 纯函数，v1.1 补的反向）。
// 方向选择用 kit.radioGroup（互斥单选组，与 base64 的方向选择同一范式）。

import type { PanelHost } from "../../extensions/facade";
import { flashError, flashSuccess } from "../feedback";
import { generatePython } from "../curl2python/gen";
import { parseCurl } from "../curl2python/parse";
import { pythonToCurl } from "./python2curl.gen";
import { t } from "../../i18n";

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const input = kit.textarea({ placeholder: t("devtools.c2p.curlPh") });
  const errEl = kit.errorSlot();

  const dir = kit.radioGroup<"c2p" | "p2c">({
    label: t("devtools.common.direction"),
    options: [
      { value: "c2p", label: "cURL → Python" },
      { value: "p2c", label: "Python → cURL" },
    ],
    value: "c2p",
    onChange: (v) => {
      input.placeholder = v === "c2p"
        ? t("devtools.c2p.curlPh")
        : t("devtools.c2p.pyPh");
    },
  });

  const convertBtn = kit.primaryButton(t("devtools.common.convert"), "play");
  const convert = (): void => {
    const text = input.value.trim();
    if (!text) {
      errEl.textContent = t("devtools.common.needInput");
      flashError(convertBtn, t("devtools.common.emptyInput"));
      return;
    }
    try {
      if (dir.get() === "c2p") {
        const cmd = parseCurl(text);
        if (!cmd.url) {
          errEl.textContent = t("devtools.c2p.noUrl");
          flashError(convertBtn, t("devtools.c2p.recognizeFailed"));
          return;
        }
        out.set(generatePython(cmd));
      } else {
        out.set(pythonToCurl(text));
      }
      errEl.textContent = "";
      flashSuccess(convertBtn, t("devtools.c2p.converted"));
    } catch (e) {
      errEl.textContent = t("devtools.common.convertFailed", { msg: e instanceof Error ? e.message : String(e) });
      flashError(convertBtn, t("devtools.c2p.convertFailedFlash"));
    }
  };
  convertBtn.addEventListener("click", convert);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) convert();
  });

  // 从剪贴板粘贴并立即转换
  const pasteBtn = kit.button(t("devtools.common.paste"), "clippy");
  pasteBtn.addEventListener("click", () => {
    void host.readClipboard().then((text) => {
      if (text !== null && text !== "") {
        input.value = text;
        convert();
      } else {
        errEl.textContent = t("devtools.c2p.clipboardFailed");
        flashError(pasteBtn, t("devtools.common.noContent"));
      }
    });
  });

  const out = kit.output({ language: "shell", placeholder: t("devtools.c2p.outPh") });
  const insertBtn = kit.button(t("devtools.common.insertEditor"), "export");
  insertBtn.dataset.tip = t("devtools.common.insertEditorTip");
  insertBtn.addEventListener("click", () => {
    const ok = host.insertToEditor(out.get());
    if (ok) flashSuccess(insertBtn, t("devtools.common.inserted"));
    else flashError(insertBtn, t("devtools.common.noFileOpen"));
  });

  wrap.append(
    input,
    kit.toolbar(dir.el, convertBtn, pasteBtn, "spacer", kit.copyButton(() => out.get()), insertBtn),
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
