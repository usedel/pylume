// JSONPath 提取器（PR-3 迁移为内置插件形态）：JSON 树状浏览 + 点击节点复制路径。
// 原实现见 devtools/jsonpath/（tree 纯函数保留原位，此处仅迁移 UI 壳）。

import type { PanelHost } from "../../extensions/facade";
import { flashError, flashSuccess } from "../feedback";
import { buildJsonTree, toJsonPath, toPythonSubscript, tryParseJson, type JsonNode } from "../jsonpath/tree";
import { takePendingJsonPathRequest } from "../../libsBridge"; // 库支持 P1 §7-3：编辑器右键带入
import { t } from "../../i18n";

// 示例数据按需构建（踩坑 ④：模块级 const 词条会在语言切换后过期）
function buildSample(): string {
  return JSON.stringify(
    {
      store: {
        book: [
          { title: t("devtools.jp.sampleTitle1"), price: 59.0 },
          { title: t("devtools.jp.sampleTitle2"), price: 79.0 },
        ],
        bicycle: { color: "red", price: 299.0 },
      },
    },
    null,
    2,
  );
}

function scalarPreview(v: unknown): string {
  if (typeof v === "string") {
    const s = JSON.stringify(v);
    return s.length > 40 ? `${s.slice(0, 40)}…` : s;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "null";
}

function valueText(node: JsonNode): string {
  if (typeof node.value === "string") return node.value;
  if (node.value === null || typeof node.value === "number" || typeof node.value === "boolean") {
    return String(node.value);
  }
  return JSON.stringify(node.value, null, 2);
}

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  let mode: "jsonpath" | "python" = "jsonpath";
  let selected: JsonNode | null = null;

  const wrap = kit.body();
  const input = kit.textarea({ placeholder: t("devtools.common.pasteJsonPh") });
  const errEl = kit.errorSlot();

  const parseBtn = kit.primaryButton(t("devtools.common.parse"), "play");
  const sampleBtn = kit.button(t("devtools.jp.sampleBtn"));
  const clearBtn = kit.button(t("devtools.common.clear"));

  // 路径区：只读输入框 + 复制按钮（首行）、格式切换（次行）
  const pathBox = document.createElement("div");
  pathBox.className = "jp-pathbox";

  const pathRow = document.createElement("div");
  pathRow.className = "jp-pathrow";
  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.readOnly = true;
  pathInput.spellcheck = false;
  pathInput.autocomplete = "off";
  pathInput.placeholder = t("devtools.jp.pathPh");
  // UI-09 例外：未选中节点时按钮 disabled，data-tip 静默失效——保留原生 title
  const copyPathBtn = document.createElement("button");
  copyPathBtn.className = "btn btn--sm";
  copyPathBtn.title = t("devtools.jp.copyPath");
  copyPathBtn.appendChild(kit.icon("copy"));
  copyPathBtn.append(t("devtools.jp.path"));
  const copyValueBtn = document.createElement("button");
  copyValueBtn.className = "btn btn--sm";
  copyValueBtn.title = t("devtools.jp.copyValue");
  copyValueBtn.appendChild(kit.icon("copy"));
  copyValueBtn.append(t("devtools.jp.value"));
  pathRow.append(pathInput, copyPathBtn, copyValueBtn);

  const modeRow = document.createElement("div");
  modeRow.className = "jp-moderow";
  const jsonpathModeBtn = document.createElement("button");
  jsonpathModeBtn.className = "btn btn--sm";
  jsonpathModeBtn.textContent = "JSONPath";
  const pyModeBtn = document.createElement("button");
  pyModeBtn.className = "btn btn--sm";
  pyModeBtn.textContent = "Python []";
  modeRow.append(jsonpathModeBtn, pyModeBtn);

  pathBox.append(pathRow, modeRow);

  // 值预览（底部可折叠）——kit.output 封装 Monaco
  const valueToggle = document.createElement("button");
  valueToggle.className = "jp-value-toggle";
  const valueCaret = kit.icon("chevron-down");
  valueToggle.appendChild(valueCaret);
  valueToggle.append(t("devtools.jp.valueToggle"));
  const valueBox = document.createElement("div");
  valueBox.className = "jp-value-box";
  const valueOut = kit.output({ language: "json" });
  valueBox.appendChild(valueOut.el);

  const treeBox = document.createElement("div");
  treeBox.className = "jp-tree";

  const setMode = (m: "jsonpath" | "python"): void => {
    mode = m;
    // UI-16：互斥模式开关的按下态用 aria-pressed 表达，与 .active 类同源切换
    jsonpathModeBtn.classList.toggle("active", m === "jsonpath");
    jsonpathModeBtn.setAttribute("aria-pressed", String(m === "jsonpath"));
    pyModeBtn.classList.toggle("active", m === "python");
    pyModeBtn.setAttribute("aria-pressed", String(m === "python"));
    updatePathBar();
  };

  const updatePathBar = (): void => {
    pathInput.value = selected ? (mode === "jsonpath" ? toJsonPath(selected) : toPythonSubscript(selected)) : "";
    copyPathBtn.disabled = !selected;
    copyValueBtn.disabled = !selected;
    if (selected) {
      valueOut.set(
        typeof selected.value === "string" ? selected.value : JSON.stringify(selected.value, null, 2),
      );
    } else {
      valueOut.clear();
    }
  };

  const select = (node: JsonNode, rowEl: HTMLElement): void => {
    selected = node;
    treeBox.querySelectorAll<HTMLElement>(".jp-row.selected").forEach((r) => r.classList.remove("selected"));
    rowEl.classList.add("selected");
    updatePathBar();
  };

  const renderNode = (node: JsonNode): HTMLElement => {
    const wrapper = document.createElement("div");
    wrapper.className = "jp-node";
    const row = document.createElement("div");
    row.className = "jp-row";
    wrapper.appendChild(row);

    const hasChildren = !!node.children && node.children.length > 0;
    const toggle = document.createElement("span");
    toggle.className = `jp-toggle${hasChildren ? "" : " hidden"}`;
    toggle.appendChild(kit.icon("chevron-right"));
    row.appendChild(toggle);

    const key = document.createElement("span");
    key.className = "jp-key";
    key.textContent = node.isIndex
      ? `[${node.segments[node.segments.length - 1]}]`
      : node.key ?? "$";
    row.appendChild(key);

    if (node.type === "object" || node.type === "array") {
      const badge = document.createElement("span");
      badge.className = `jp-badge jp-${node.type}`;
      badge.textContent = node.type === "array" ? `[${node.children?.length ?? 0}]` : `{${node.children?.length ?? 0}}`;
      row.appendChild(badge);
    } else {
      const val = document.createElement("span");
      val.className = `jp-value jp-${node.type}`;
      val.textContent = scalarPreview(node.value);
      row.appendChild(val);
    }

    row.addEventListener("click", () => select(node, row));

    const childrenBox = document.createElement("div");
    childrenBox.className = "jp-children hidden";
    wrapper.appendChild(childrenBox);

    if (hasChildren) {
      let expanded = false;
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        expanded = !expanded;
        toggle.classList.toggle("expanded", expanded);
        if (expanded) {
          if (childrenBox.childElementCount === 0) {
            for (const c of node.children ?? []) childrenBox.appendChild(renderNode(c));
          }
          childrenBox.classList.remove("hidden");
        } else {
          childrenBox.classList.add("hidden");
        }
      });
    }

    return wrapper;
  };

  const parse = (): void => {
    const text = input.value.trim();
    if (!text) {
      errEl.textContent = t("devtools.jp.needInput");
      flashError(parseBtn, t("devtools.common.emptyInput"));
      return;
    }
    const r = tryParseJson(text);
    if (!r.ok) {
      errEl.textContent = t("devtools.common.jsonParseFailed", { msg: r.error });
      flashError(parseBtn, t("devtools.jp.parseFailedFlash"));
      return;
    }
    selected = null;
    treeBox.textContent = "";
    treeBox.appendChild(renderNode(buildJsonTree(r.value)));
    errEl.textContent = "";
    flashSuccess(parseBtn, t("devtools.jp.parsed"));
    updatePathBar();
  };

  parseBtn.addEventListener("click", parse);
  sampleBtn.addEventListener("click", () => {
    input.value = buildSample();
    parse();
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    selected = null;
    treeBox.textContent = "";
    errEl.textContent = "";
    updatePathBar();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) parse();
  });
  jsonpathModeBtn.addEventListener("click", () => setMode("jsonpath"));
  pyModeBtn.addEventListener("click", () => setMode("python"));
  copyPathBtn.addEventListener("click", () => {
    if (!pathInput.value) return;
    void host.copyToClipboard(pathInput.value).then((ok) => {
      if (ok) flashSuccess(copyPathBtn, t("devtools.common.copied"));
      else flashError(copyPathBtn, t("devtools.common.copyFailed"));
    });
  });
  copyValueBtn.addEventListener("click", () => {
    if (!selected) return;
    void host.copyToClipboard(valueText(selected)).then((ok) => {
      if (ok) flashSuccess(copyValueBtn, t("devtools.common.copied"));
      else flashError(copyValueBtn, t("devtools.common.copyFailed"));
    });
  });

  // 值预览折叠
  let valueOpen = false;
  const setValueOpen = (open: boolean): void => {
    valueOpen = open;
    valueBox.classList.toggle("hidden", !open);
    valueCaret.classList.toggle("expanded", open);
  };
  valueToggle.addEventListener("click", () => setValueOpen(!valueOpen));
  setValueOpen(false);

  wrap.append(input, kit.toolbar(parseBtn, sampleBtn, clearBtn), errEl, pathBox, treeBox, valueToggle, valueBox);
  host.root.appendChild(wrap);

  copyPathBtn.disabled = true;
  copyValueBtn.disabled = true;
  setMode("jsonpath");

  // 库支持 P1 §7-3：编辑器「JSONPath 提取」右键带入的字面量 → 填入并自动解析
  const pendingReq = takePendingJsonPathRequest();
  if (pendingReq) {
    input.value = pendingReq.json;
    parse();
  }

  return {
    dispose() {
      valueOut.dispose();
    },
  };
}
