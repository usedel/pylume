// 格式串工具面板（库特别支持 PR-3，docs/python_library_support_dev_plan.md §5 +
// research §11.4 交互冻结）。求值统一走 libEval（format_preview kind，PR-1 受控脚本）。
// 降级口径（§5）：无解释器 → 预览置灰提示，速查表照常可用，**不做 JS 近似**。

import type { PanelHost } from "../../extensions/facade";
import { createEvalController, type EvalResult } from "../../libEval";
import {
  FORMAT_CHIP_ORDER,
  LOGGING_CHIP_ORDER,
  LOGGING_FIELDS,
  STRFTIME_CHIP_ORDER,
  STRFTIME_CODES,
  segmentFormat,
  type FormatMode,
} from "../../libFormat";
import { takePendingFormatRequest } from "../../libsBridge";
import { t } from "../../i18n";

interface FormatEvalData {
  result: string;
}

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  // lens / 右键带入的上下文（§11.1-2 聚合 lens 落点；挂载时取走，取后清空）
  const initial = takePendingFormatRequest();

  // ---------- 骨架 ----------
  const wrap = kit.body();

  // 三模式（互斥 → radioGroup，§11.4；初始模式由带入请求决定）
  const modeGroup = kit.radioGroup<FormatMode>({
    label: t("devtools.fmt.mode"),
    options: [
      { value: "strftime", label: t("devtools.fmt.modeStrftime") },
      { value: "format", label: t("devtools.fmt.modeFormat") },
      { value: "logging", label: "logging" },
    ],
    value: initial?.mode ?? "strftime",
    onChange: () => {
      syncMode();
      scheduleEval(true);
    },
  });

  // 格式输入（点击解释段时定位）
  const fmtEl = kit.input({ placeholder: "%Y-%m-%d %H:%M:%S", onInput: () => scheduleEval() });
  if (initial) fmtEl.value = initial.fmt;
  fmtEl.id = "fmt-input";

  // 速查 chips（按频率排序，点击插入光标处；data-tip 释义）
  const chipsRow = document.createElement("div");
  chipsRow.className = "rx-chips";
  chipsRow.id = "fmt-chips";

  // 示例值（strftime 用当前时间，无输入；其余模式可编辑）
  const sampleRow = kit.row();
  sampleRow.id = "fmt-sample-row";
  const sampleLabel = document.createElement("span");
  sampleLabel.className = "rx-flags-summary";
  sampleLabel.textContent = t("devtools.fmt.sampleLabel");
  const sampleEl = kit.input({ placeholder: t("devtools.fmt.samplePh"), onInput: () => scheduleEval() });
  sampleEl.id = "fmt-sample";
  sampleRow.append(sampleLabel, sampleEl);

  // 逐段解释（点击段 → 模式框内选中，§11.4）
  const segRow = document.createElement("div");
  segRow.className = "fmt-segments";
  segRow.id = "fmt-segments";

  // 结果区（等宽 + 复制按钮就近，缺陷 #20 教训）
  const out = kit.output({ language: "plaintext", placeholder: t("devtools.fmt.outPh"), readOnly: true });
  out.el.classList.add("fmt-out");
  out.el.id = "fmt-out";

  // 状态行（六态 + 降级）
  const statusEl = document.createElement("div");
  statusEl.className = "rx-status";
  statusEl.id = "fmt-status";

  const actionsRow = kit.toolbar("spacer", kit.copyButton(() => out.get()), kit.clearButton(fmtEl));
  actionsRow.id = "fmt-actions";

  wrap.append(modeGroup.el, fmtEl, chipsRow, sampleRow, segRow, out.el, statusEl, actionsRow);
  host.root.appendChild(wrap);

  // ---------- chips ----------
  function renderChips(): void {
    const mode = modeGroup.get();
    chipsRow.textContent = "";
    const items: Array<{ text: string; desc: string }> = [];
    if (mode === "strftime") {
      for (const code of STRFTIME_CHIP_ORDER) items.push({ text: `%${code}`, desc: STRFTIME_CODES[code] ?? "" });
    } else if (mode === "logging") {
      for (const f of LOGGING_CHIP_ORDER) items.push({ text: `(%${f})s`.replace("(%", "%("), desc: LOGGING_FIELDS[f] ?? "" });
    } else {
      for (const spec of FORMAT_CHIP_ORDER) items.push({ text: spec, desc: segmentFormat("format", spec)[0]?.desc ?? "" });
    }
    for (const it of items) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "btn rx-chip";
      chip.textContent = it.text;
      chip.dataset.tip = it.desc;
      chip.setAttribute("aria-label", it.desc);
      chip.addEventListener("click", () => {
        // 插入到光标处（§11.4：点击插入码位）
        const start = fmtEl.selectionStart ?? fmtEl.value.length;
        const end = fmtEl.selectionEnd ?? start;
        fmtEl.value = fmtEl.value.slice(0, start) + it.text + fmtEl.value.slice(end);
        const pos = start + it.text.length;
        fmtEl.setSelectionRange(pos, pos);
        fmtEl.focus();
        scheduleEval();
      });
      chipsRow.appendChild(chip);
    }
  }

  function syncMode(): void {
    const mode = modeGroup.get();
    fmtEl.placeholder = mode === "strftime" ? "%Y-%m-%d %H:%M:%S" : mode === "format" ? "{:>10,.2f}" : "%(asctime)s %(levelname)s %(message)s";
    sampleRow.classList.toggle("hidden", mode === "strftime");
    sampleEl.placeholder = mode === "format" ? '1234.5678 / [1, "a"]' : '{"message": "hello", "level": "WARNING"}';
    renderChips();
    renderSegments();
  }

  // ---------- 示例值解析 ----------
  function parseSample(): unknown {
    const raw = sampleEl.value.trim();
    if (!raw) return modeGroup.get() === "logging" ? {} : undefined;
    try {
      return JSON.parse(raw);
    } catch {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
  }

  // ---------- 求值 ----------
  const controller = createEvalController<FormatEvalData>("format_preview", {
    workspaceRoot: () => host.workspaceRoot(),
  });
  let lastRes: EvalResult<FormatEvalData> | null = null;

  let pendingTimer = 0;
  function scheduleEval(force = false): void {
    renderSegments();
    window.clearTimeout(pendingTimer);
    if (force) {
      void runEval(true);
      return;
    }
    pendingTimer = window.setTimeout(() => void runEval(false), 0);
  }

  async function runEval(force: boolean): Promise<void> {
    const fmt = fmtEl.value;
    if (!fmt) {
      setStatus("empty");
      out.clear();
      lastRes = null;
      return;
    }
    const values = parseSample();
    const args = { mode: modeGroup.get(), fmt, values };
    const res = force ? await controller.force(args) : await controller.request(args);
    if (res.stale) return;
    lastRes = res;
    renderResult();
  }

  // ---------- 渲染 ----------

  function renderSegments(): void {
    const fmt = fmtEl.value;
    segRow.textContent = "";
    if (!fmt) return;
    for (const t of segmentFormat(modeGroup.get(), fmt)) {
      const seg = document.createElement("button");
      seg.type = "button";
      seg.className = "fmt-seg" + (t.unknown ? " fmt-seg--unknown" : "");
      seg.textContent = t.text;
      seg.dataset.tip = t.desc;
      seg.setAttribute("aria-label", t.desc);
      seg.addEventListener("click", () => {
        // 点击段 → 模式框内选中该段（§11.4）
        fmtEl.focus();
        fmtEl.setSelectionRange(t.pos, t.pos + t.length);
      });
      segRow.appendChild(seg);
    }
  }

  function renderResult(): void {
    const res = lastRes;
    if (!res) return;
    if (res.state === "ok") {
      setStatus("ok");
      out.set(res.data?.result ?? "");
      out.el.classList.remove("fmt-out--degraded");
      return;
    }
    if (res.state === "err") {
      setStatus("err", res.error);
      return;
    }
    if (res.state === "timeout") {
      setStatus("timeout");
      return;
    }
    if (res.state === "noInterpreter") {
      setStatus("degraded");
      out.el.classList.add("fmt-out--degraded");
      return;
    }
    setStatus("pending");
  }

  function setStatus(state: "empty" | "ok" | "err" | "timeout" | "degraded" | "pending", detail?: string): void {
    statusEl.className = "rx-status";
    if (state === "empty") {
      statusEl.classList.add("rx-status--idle");
      statusEl.textContent = t("devtools.fmt.empty");
      return;
    }
    if (state === "ok") {
      statusEl.classList.add("rx-status--ok");
      statusEl.textContent = "";
      return;
    }
    if (state === "err") {
      statusEl.classList.add("rx-status--err");
      statusEl.textContent = detail ?? t("devtools.fmt.invalid");
      return;
    }
    if (state === "timeout") {
      statusEl.classList.add("rx-status--err");
      statusEl.textContent = t("devtools.fmt.timeout");
      return;
    }
    if (state === "degraded") {
      statusEl.classList.add("rx-status--degraded");
      statusEl.textContent = t("devtools.fmt.noInterpreter");
      return;
    }
    statusEl.classList.add("rx-status--pending");
    statusEl.textContent = t("devtools.common.evaluating");
  }

  // Ctrl+Enter 强制求值（§11.2）
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runEval(true);
    }
  });

  syncMode();
  if (initial) {
    scheduleEval(true); // 带入上下文：立即求值
  } else {
    setStatus("empty");
  }

  return {
    dispose() {
      window.clearTimeout(pendingTimer);
      out.dispose();
      controller.cancel();
    },
  };
}
