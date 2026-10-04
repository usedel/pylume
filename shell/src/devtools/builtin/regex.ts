// 正则测试器（库特别支持 PR-2，docs/python_library_support_dev_plan.md §4.3 +
// research §11.3 线框/六态冻结）。求值统一走 libEval（§2-5 纪律），真值来自真实 re 引擎（I-3）。
// 交互契约（§11.2）：200ms 防抖在 libEval 控制器内；陈旧灰显不清空；错误原文 + caret 定位；
// 结果上限 500 + 总数徽标；写回三动作（复制 / 插入 / 替换字面量，sourceDirty 置灰）。

import type { PanelHost } from "../../extensions/facade";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { flashError, flashSuccess } from "../feedback";
import { createEvalController, type EvalResult } from "../../libEval";
import {
  FLAG_DEFS,
  flagsToValue,
  formatRegexPython,
  staticDiagnostics,
} from "../../libRegex";
import { replaceRegexLiteralInEditor } from "../../dslLens";
import { takePendingRegexRequest, type RegexPanelRequest } from "../../libsBridge";
import { openSettingsPanel } from "../../settingsPanel"; // §11.2 降级态：[设置解释器] 引导跳设置页
import { t } from "../../i18n";

/** 匹配表上限（§11.2：仅显示前 N 项 + 总数徽标） */
const MATCH_CAP = 500;

interface MatchInfo {
  span: [number, number];
  groups: Array<string | null>;
  named: Record<string, string | null>;
}

interface RegexEvalData {
  match: MatchInfo | null;
  matches: MatchInfo[];
  count: number;
  truncated: boolean;
  sub?: { result: string; count: number };
}

export function mount(host: PanelHost): { dispose(): void } | void {
  const { kit } = host;
  host.root.textContent = "";

  // ---------- 状态 ----------
  let sourceInfo: { contentOffset: number; source: string; pattern: string } | null = null;
  /** 用户是否手改过模式（§11.2 sourceDirty ②：不覆盖手改内容） */
  let userEditedPattern = false;

  // ---------- 骨架 ----------
  const wrap = kit.body();

  // 求值中：顶部细进度条（§11.2：陈旧灰显而非清空，不要 spinner）
  const progressEl = document.createElement("div");
  progressEl.className = "rx-progress hidden";
  progressEl.id = "rx-progress";

  // 模式（单行；re.X 时切多行）
  const patternEl = kit.textarea({
    rows: 1,
    placeholder: 'r"\\b(\\w+)@(\\w+)\\.com"',
    onInput: () => {
      userEditedPattern = true; // §11.2：手改过的内容不被编辑器带入覆盖
      scheduleEval();
    },
  });
  patternEl.id = "rx-pattern";
  const flagsSummary = document.createElement("span");
  flagsSummary.className = "rx-flags-summary";
  flagsSummary.id = "rx-flags-summary";

  // flags 五开关（多选 → aria-pressed，§11.3.2 缺陷 #23 纪律：互斥才用 radioGroup）
  const flagsRow = document.createElement("div");
  flagsRow.className = "rx-flags";
  flagsRow.id = "rx-flags";
  flagsRow.setAttribute("role", "group");
  flagsRow.setAttribute("aria-label", t("devtools.rx.flagsAria"));
  const flagButtons = new Map<string, HTMLButtonElement>();
  for (const f of FLAG_DEFS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--icon rx-flag-btn";
    btn.textContent = f.key;
    btn.dataset.tip = f.desc;
    btn.setAttribute("aria-label", f.desc);
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      syncFlagUi();
      scheduleEval();
    });
    flagButtons.set(f.key, btn);
    flagsRow.appendChild(btn);
  }
  const activeFlags = (): string[] =>
    FLAG_DEFS.filter((f) => flagButtons.get(f.key)?.getAttribute("aria-pressed") === "true").map((f) => f.key);

  const setFlags = (flags: string[]): void => {
    for (const [key, btn] of flagButtons) btn.setAttribute("aria-pressed", String(flags.includes(key)));
    syncFlagUi();
  };

  // 非 raw 提示条（仅编辑器带入非 raw 串时出现，§11.3.1）
  const rawHint = document.createElement("div");
  rawHint.className = "rx-raw-hint hidden";
  rawHint.id = "rx-raw-hint";
  rawHint.textContent = t("devtools.rx.rawHint");

  // 视图互斥（匹配 / 替换 → radioGroup）
  const view = kit.radioGroup<"match" | "sub">({
    label: t("devtools.rx.view"),
    options: [
      { value: "match", label: t("devtools.rx.match") },
      { value: "sub", label: t("devtools.rx.sub") },
    ],
    value: "match",
    onChange: () => syncView(),
  });

  // 测试文本（P6 定案：只读 Monaco，宿主 monaco 模块）
  const testWrap = document.createElement("div");
  testWrap.className = "rx-test";
  testWrap.id = "rx-test";
  const monaco = host.monaco;
  let testEditor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
  let hitDecos: MonacoApi.editor.IEditorDecorationsCollection | null = null;
  /** 选中匹配的边框装饰（独立集合：不与奇偶交替底色互相覆盖，§11.3.2） */
  let selDecos: MonacoApi.editor.IEditorDecorationsCollection | null = null;
  /** 当前选中匹配（Ctrl+C 复制用，§11.3.2） */
  let selectedMatch: MatchInfo | null = null;
  /** 测试文本变更 → 重算（可编辑；「只读」仅指不写回任何文件） */
  let suppressTestInput = false;

  // 求值产出区（匹配表 + 替换结果）：求值中降透明度、无解释器整块置灰（§11.2 陈旧灰显 / 降级置灰）
  const evalZone = document.createElement("div");
  evalZone.className = "rx-eval-zone";
  evalZone.id = "rx-eval-zone";

  // 匹配表（真 <table> 语义，§11.9）
  const tableWrap = document.createElement("div");
  tableWrap.className = "rx-table-wrap";
  tableWrap.id = "rx-table";
  const table = document.createElement("table");
  table.className = "rx-table";
  const truncNote = document.createElement("div");
  truncNote.className = "rx-truncated hidden";
  tableWrap.appendChild(table);
  tableWrap.appendChild(truncNote);

  // 替换视图
  const replRow = document.createElement("div");
  replRow.className = "hidden";
  replRow.id = "rx-repl-row";
  const replEl = kit.input({ placeholder: "\\g<2>.\\g<1>", onInput: () => scheduleEval() });
  const subOut = document.createElement("div");
  subOut.className = "rx-sub-out";
  subOut.id = "rx-sub-out";

  // 状态行（六态呈现，§11.3.3）
  const statusEl = document.createElement("div");
  statusEl.className = "rx-status";
  statusEl.id = "rx-status";

  // 无解释器引导（§11.2 / §11.3.3：求值区置灰 + [设置解释器] 跳设置页）
  const guideRow = document.createElement("div");
  guideRow.className = "rx-guide hidden";
  guideRow.id = "rx-guide";
  const interpBtn = kit.button(t("devtools.rx.setInterpreter"), "gear", () => openSettingsPanel("python"));
  interpBtn.id = "rx-open-settings";
  guideRow.append(interpBtn);

  // 空态示例 chips（邮箱 / URL / 日期 / 数字 / HTML 标签）
  const examples: Array<[string, string, string]> = [
    [t("devtools.rx.exEmail"), "[\\w.+-]+@[\\w-]+\\.[\\w.]+", "alice@corp.com, bob@corp.com"],
    ["URL", "https?://[^\\s/]+(?:/[^\\s]*)?", "visit https://example.com/a?b=1 now"],
    [t("devtools.rx.exDate"), "(\\d{4})-(\\d{2})-(\\d{2})", "due 2026-09-27 and 2027-01-01"],
    [t("devtools.rx.exNum"), "-?\\d+\\.?\\d*", "x = -3.14, y = 42"],
    [t("devtools.rx.exHtml"), "<([a-z]+)[^>]*>(.*?)</\\1>", "<b>bold</b> and <i>italic</i>"],
  ];
  const chipsRow = document.createElement("div");
  chipsRow.className = "rx-chips";
  chipsRow.id = "rx-chips";
  for (const [label, pattern, test] of examples) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "btn rx-chip";
    chip.textContent = label;
    chip.dataset.tip = t("devtools.rx.exampleTip", { pattern: pattern });
    chip.addEventListener("click", () => {
      patternEl.value = pattern;
      suppressTestInput = true;
      testText = test;
      testEditor?.setValue(test);
      suppressTestInput = false;
      sourceInfo = null;
      scheduleEval(true);
    });
    chipsRow.appendChild(chip);
  }

  // 底部三动作（§11.2 写回统一命名）
  const copyCodeBtn = kit.copyButton(() => formatRegexPython(patternEl.value, activeFlags()));
  copyCodeBtn.id = "rx-copy-code";
  const insertBtn = kit.button(t("devtools.common.insertEditor"), "export", () => {
    const ok = host.insertToEditor(formatRegexPython(patternEl.value, activeFlags()));
    if (ok) flashSuccess(insertBtn, t("devtools.common.inserted"));
    else flashError(insertBtn, t("devtools.common.noFileOpen"));
  });
  insertBtn.id = "rx-insert";
  const replaceBtn = kit.button(t("devtools.rx.replaceLiteral"), "replace", () => {
    if (!sourceInfo || patternEl.value === sourceInfo.pattern) return;
    const newSource = `r"${patternEl.value.replace(/"/g, '\\"')}"`;
    const ok = replaceRegexLiteralInEditor(sourceInfo.contentOffset, sourceInfo.source, newSource);
    if (!ok) {
      flashError(replaceBtn, t("devtools.rx.replaceFailed"));
      return;
    }
    sourceInfo = { ...sourceInfo, source: newSource, pattern: patternEl.value };
    flashSuccess(replaceBtn, t("devtools.rx.replaced"));
  });
  replaceBtn.id = "rx-replace";

  const actionsRow = kit.toolbar(
    copyCodeBtn,
    "spacer",
    insertBtn,
    replaceBtn,
  );
  actionsRow.id = "rx-actions";

  wrap.append(
    progressEl,
    kit.row(patternEl, flagsSummary),
    flagsRow,
    rawHint,
    view.el,
    chipsRow,
    testWrap,
    evalZone,
    statusEl,
    guideRow,
    actionsRow,
  );
  replRow.append(kit.row(replEl), subOut);
  evalZone.append(tableWrap, replRow);
  host.root.appendChild(wrap);

  // ---------- 测试文本 Monaco（只读） ----------
  let testText = "";
  if (monaco) {
    testEditor = monaco.editor.create(testWrap, {
      value: "",
      language: "plaintext",
      readOnly: false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      wordWrap: "on",
    });
    hitDecos = testEditor.createDecorationsCollection([]);
    selDecos = testEditor.createDecorationsCollection([]);
    testEditor.onDidChangeModelContent(() => {
      if (suppressTestInput) return;
      testText = testEditor!.getValue();
      scheduleEval();
    });
  }

  function syncFlagUi(): void {
    const flags = activeFlags();
    flagsSummary.textContent = flags.length ? flags.join(" · ") : "";
    // re.X：模式切多行（§11.3.2）
    patternEl.rows = flags.includes("X") ? 5 : 1;
    if (flags.includes("X") && !patternEl.value.includes("\n") && !patternEl.dataset.xHinted) {
      patternEl.dataset.xHinted = "1";
      patternEl.dataset.tip = t("devtools.rx.xHint");
    }
  }

  function syncView(): void {
    const isSub = view.get() === "sub";
    replRow.classList.toggle("hidden", !isSub);
  }

  /** sourceDirty：从编辑器带入后 pattern 被手改 → 替换字面量置灰（§11.2-1） */
  function syncWriteback(): void {
    const dirty = sourceInfo !== null && patternEl.value !== sourceInfo.pattern;
    replaceBtn.disabled = sourceInfo === null || dirty;
    replaceBtn.dataset.tip = sourceInfo === null
      ? t("devtools.rx.tipNotFromEditor")
      : dirty
        ? t("devtools.rx.tipDirty")
        : t("devtools.rx.tipWriteback");
  }

  // ---------- 求值（libEval 统一控制器：防抖 200ms / 四态 / force） ----------
  const controller = createEvalController<RegexEvalData>("regex_test", {
    workspaceRoot: () => host.workspaceRoot(),
  });

  let pendingTimer = 0;
  function scheduleEval(force = false): void {
    syncWriteback();
    renderLocal();
    window.clearTimeout(pendingTimer);
    if (force) {
      void runEval(true);
      return;
    }
    pendingTimer = window.setTimeout(() => void runEval(false), 0);
  }

  async function runEval(force: boolean): Promise<void> {
    const pattern = patternEl.value;
    if (!pattern) {
      renderState("empty");
      return;
    }
    // 静态已判定为错误（括号不闭合等）：不浪费一次 IPC，也不显示进度条
    if (staticDiagnostics(pattern, true).some((d) => d.severity === "error")) {
      renderStatusLine();
      return;
    }
    const args = {
      pattern,
      flags: flagsToValue(activeFlags()),
      test: testText,
      repl: view.get() === "sub" ? replEl.value : undefined,
    };
    setStale(true); // 求值中：上次结果灰显 + 顶部细进度条（§11.2）
    const res = force ? await controller.force(args) : await controller.request(args);
    if (res.stale) return; // 被更新的求值超越：丢弃本次渲染（§11.2 陈旧灰显由下次结果接管）
    setStale(false);
    render(res, pattern);
  }

  // ---------- 渲染 ----------

  function renderLocal(): void {
    // 本地即时反馈：静态诊断（离线，I-3：只提示、不冒充匹配真值）
    syncWriteback();
    renderStatusLine();
  }

  function render(res: EvalResult<RegexEvalData>, evaluatedPattern: string): void {
    if (patternEl.value !== evaluatedPattern) return; // 输入已变，等下一次结果
    lastResult = res;
    if (res.state === "ok" && res.data) renderMatches(res.data);
    renderStatusLine();
  }

  let lastResult: EvalResult<RegexEvalData> | null = null;

  function renderMatches(data: RegexEvalData): void {
    // 结果换了一批：选中态与新结果无关，清掉（奇偶底色由 hitDecos 重建）
    selDecos?.clear();
    selectedMatch = null;
    // 表
    table.textContent = "";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const h of ["#", t("devtools.rx.colPos"), t("devtools.rx.match"), t("devtools.rx.colGroups")]) {
      const th = document.createElement("th");
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    const shown = data.matches.slice(0, MATCH_CAP);
    shown.forEach((m, i) => {
      const tr = document.createElement("tr");
      tr.className = "rx-row";
      tr.dataset.index = String(i);
      const cells = [
        String(i + 1),
        `${m.span[0]}-${m.span[1]}`,
        testText.slice(m.span[0], m.span[1]),
        groupSummary(m),
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      tr.addEventListener("click", () => locateMatch(m));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // 匹配高亮（奇偶交替两种底色，§11.3.2）
    if (testEditor && hitDecos) {
      const model = testEditor.getModel();
      const decos: MonacoApi.editor.IModelDeltaDecoration[] = [];
      if (model) {
        shown.forEach((m, i) => {
          const s = model.getPositionAt(m.span[0]);
          const e = model.getPositionAt(m.span[1]);
          decos.push({
            range: new host.monaco!.Range(s.lineNumber, s.column, e.lineNumber, e.column),
            options: {
              inlineClassName: i % 2 === 0 ? "oc-regex-hit-a" : "oc-regex-hit-b",
              stickiness: 1,
            },
          });
        });
      }
      hitDecos.set(decos);
    }

    // 截断徽标（§11.9 截断文案模板）
    truncNote.classList.toggle("hidden", !data.truncated);
    if (data.truncated) truncNote.textContent = t("devtools.rx.truncated", { cap: MATCH_CAP, total: data.count });

    // 替换结果
    subOut.textContent = data.sub ? data.sub.result : "";
  }

  function groupSummary(m: MatchInfo): string {
    const namedEntries = Object.entries(m.named).filter(([, v]) => v !== null);
    if (namedEntries.length) return namedEntries.map(([k, v]) => `${k}=${v}`).join(" ");
    const idx = m.groups.map((v, i) => [v, i + 1] as const).filter(([v]) => v !== null);
    if (!idx.length) return "-";
    return idx.map(([v, i]) => `${i}=${v}`).join(" ");
  }

  function locateMatch(m: MatchInfo): void {
    const model = testEditor?.getModel();
    if (!model || !testEditor) return;
    const s = model.getPositionAt(m.span[0]);
    const e = model.getPositionAt(m.span[1]);
    const range = new host.monaco!.Range(s.lineNumber, s.column, e.lineNumber, e.column);
    testEditor.setSelection(range);
    testEditor.revealRangeInCenter(range);
    // 当前匹配加边框：独立装饰集合，奇偶交替底色保留（§11.3.2）
    selDecos?.set([
      {
        range,
        options: { inlineClassName: "oc-regex-hit-sel", stickiness: 1 },
      },
    ]);
    selectedMatch = m;
  }

  /** 求值中：保留上次结果降透明度 + 顶部细进度条（§11.2：不要 spinner、不要清空） */
  function setStale(on: boolean): void {
    evalZone.classList.toggle("is-stale", on);
    progressEl.classList.toggle("hidden", !on);
  }

  /** 无解释器：求值产出区整块置灰 + [设置解释器] 引导（§11.2 / §11.3.3） */
  function setDegraded(on: boolean): void {
    evalZone.classList.toggle("is-disabled", on);
    guideRow.classList.toggle("hidden", !on);
  }

  /** 六态呈现（§11.3.3 + §11.9 文案模板） */
  function renderState(state: "empty" | "nomatch" | "evaluating" | "result"): void {
    statusEl.className = "rx-status";
    chipsRow.classList.toggle("hidden", state !== "empty");
    if (state === "empty") {
      statusEl.classList.add("rx-status--idle");
      statusEl.textContent = t("devtools.rx.empty");
      table.textContent = "";
      hitDecos?.clear();
      selDecos?.clear();
      selectedMatch = null;
      setStale(false);
      return;
    }
    if (state === "nomatch") {
      statusEl.classList.add("rx-status--idle");
      statusEl.textContent = t("devtools.rx.noMatch");
      setStale(false);
      return;
    }
    if (state === "evaluating") {
      statusEl.classList.add("rx-status--pending");
      statusEl.textContent = t("devtools.common.evaluating");
      setStale(true); // 上次结果留在原地灰显，表格高度不抖动
    }
  }

  function renderStatusLine(): void {
    const pattern = patternEl.value;
    if (!pattern) {
      renderState("empty");
      return;
    }
    // 静态诊断先行（离线即时）：错误 → 红字原文 + caret 定位（I-3：只报客观错误，不冒充匹配真值）
    const diags = staticDiagnostics(pattern, true);
    const errorDiag = diags.find((d) => d.severity === "error");
    if (errorDiag) {
      statusEl.className = "rx-status rx-status--err";
      statusEl.textContent = errorDiag.message;
      caretInPattern(errorDiag.pos);
      table.textContent = "";
      hitDecos?.clear();
      selDecos?.clear();
      selectedMatch = null;
      setStale(false);
      setDegraded(false);
      return;
    }

    const res = lastResult;
    if (!res) {
      renderState("evaluating");
      return;
    }
    switch (res.state) {
      case "ok": {
        setDegraded(false);
        const data = res.data!;
        if (data.count === 0) {
          renderState("nomatch");
          table.textContent = "";
          hitDecos?.clear();
          selDecos?.clear();
          selectedMatch = null;
        } else {
          statusEl.className = "rx-status rx-status--ok";
          statusEl.textContent =
            t("devtools.rx.matchCount", { total: data.count }) +
            (data.truncated ? t("devtools.rx.matchCapSuffix", { cap: MATCH_CAP }) : "");
        }
        caretClear();
        break;
      }
      case "err":
        setDegraded(false);
        statusEl.className = "rx-status rx-status--err";
        statusEl.textContent = res.error ?? t("devtools.rx.invalidPattern");
        caretFromReError(res.error ?? "");
        break;
      case "timeout":
        setDegraded(false);
        statusEl.className = "rx-status rx-status--err";
        statusEl.textContent = t("devtools.rx.timeout");
        break;
      case "noInterpreter":
        // 求值产出区置灰 + [设置解释器] 引导；模式解释（离线）仍可用
        setStale(false);
        setDegraded(true);
        statusEl.className = "rx-status rx-status--degraded";
        statusEl.textContent = t("devtools.rx.noInterpreter");
        break;
      case "pending":
        renderState("evaluating");
        break;
      default:
        break;
    }
  }

  /** re.error 原文里的 "at position N" → 模式框 caret 定位（§11.2 错误展示原文） */
  function caretFromReError(err: string): void {
    const m = /at position (\d+)/.exec(err);
    if (m) caretInPattern(Number(m[1]));
  }

  function caretInPattern(pos: number): void {
    patternEl.focus();
    const p = Math.min(pos, patternEl.value.length);
    patternEl.setSelectionRange(p, p + 1);
  }

  function caretClear(): void {
    // 不抢焦点，仅清选区
    try {
      patternEl.setSelectionRange(patternEl.selectionStart, patternEl.selectionStart);
    } catch {
      /* ignore */
    }
  }

  /** 非 raw 粗判提示条已由编辑器带入时的 isRaw 标志决定，此处不再重复判定 */

  // Ctrl+Enter 强制求值（§11.2：跳过防抖）
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runEval(true);
      return;
    }
    // Ctrl+C 复制当前匹配（§11.3.2）：无选区时才接管，避免抢走正常复制
    if ((e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey)) {
      if (!selectedMatch || hasActiveTextSelection(e.target)) return;
      const text = testText.slice(selectedMatch.span[0], selectedMatch.span[1]);
      if (!text) return;
      e.preventDefault();
      void host.copyToClipboard(text).then((ok) =>
        host.toast(ok ? t("devtools.rx.copiedMatch") : t("devtools.common.copyFailed"), ok ? "ok" : "error"),
      );
    }
  });

  /** 事件目标是否已有文本选区（输入框选区 / 页面选区） */
  function hasActiveTextSelection(target: EventTarget | null): boolean {
    const el = target as HTMLTextAreaElement | HTMLInputElement | null;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      return el.selectionStart !== el.selectionEnd;
    }
    return Boolean(window.getSelection()?.toString());
  }

  /** 带入编辑器上下文（lens / 右键 / 键位）；用户已手改过模式时不覆盖（§11.2 sourceDirty ②） */
  function applyRegexRequest(req: RegexPanelRequest): void {
    if (userEditedPattern) {
      host.toast(t("devtools.rx.broughtKept"), "info");
      return;
    }
    sourceInfo = { contentOffset: req.contentOffset, source: req.source, pattern: req.pattern };
    patternEl.value = req.pattern;
    setFlags(req.flags);
    rawHint.classList.toggle("hidden", req.isRaw);
  }

  // ---------- 编辑器上下文（lens / 右键 / 键位带入） ----------
  // 过期请求（面板被 LRU 逐出后重新挂载）已在 libsBridge 内按 TTL 丢弃，不套用陈旧上下文
  const req = takePendingRegexRequest();
  if (req) applyRegexRequest(req);

  // ---------- 初始渲染 ----------
  syncFlagUi();
  syncView();
  syncWriteback();
  renderStatusLine();

  return {
    dispose() {
      window.clearTimeout(pendingTimer);
      testEditor?.dispose();
      controller.cancel();
    },
  };
}
