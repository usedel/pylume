// P6 探针：面板内「只读 Monaco 实例」的成本 vs「span 覆盖层」方案
// 决定：正则测试器的测试文本用哪种形态（Monaco 还是轻量 span 覆盖层）
//
// 只引 editor.api + 极少数 contrib（对齐 src/monaco.ts 的按需裁剪原则），
// 语言用 plaintext（测试文本是任意用户输入，不需要 tokenizer，与产品形态一致）。

import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding";

const LINE = "contact: alice@corp.com, bob@corp.com, carol@example.org — 2026-09-27 14:03:11 #42";
const TEXT = Array.from({ length: 40 }, (_, i) => `${i + 1}. ${LINE}`).join("\n"); // ~2.9KB / 40 行
const MATCH_COUNT = 500;

const nextFrame = () =>
  new Promise<number>((res) => {
    const t0 = performance.now();
    requestAnimationFrame(() => res(performance.now() - t0));
  });

function makeContainer(id: string): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  el.style.width = "360px"; // 面板真实宽度
  el.style.height = "200px";
  el.style.position = "absolute";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  return el;
}

/** 造 MATCH_COUNT 个 range（模拟 500 处匹配高亮） */
function makeRanges(model: monaco.editor.ITextModel): monaco.IRange[] {
  const ranges: monaco.IRange[] = [];
  const lines = model.getLineCount();
  for (let i = 0; i < MATCH_COUNT; i++) {
    const line = (i % lines) + 1;
    ranges.push({ startLineNumber: line, startColumn: 10, endLineNumber: line, endColumn: 24 });
  }
  return ranges;
}

async function main() {
  const result: Record<string, unknown> = {
    probe: "P6 面板内只读 Monaco 成本",
    monacoVersion: (monaco as unknown as { version?: string }).version ?? null,
    textChars: TEXT.length,
    textLines: TEXT.split("\n").length,
    matchCount: MATCH_COUNT,
    userAgent: navigator.userAgent,
  };

  const heap = (): number | null => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? m.usedJSHeapSize : null;
  };
  const heap0 = heap();

  // --- 1) 创建 1/2/3 个只读实例（第 2、3 个才是「面板再开一个」的真实边际成本） ---
  const creates: Array<Record<string, number>> = [];
  const editors: monaco.editor.IStandaloneCodeEditor[] = [];
  for (let i = 1; i <= 3; i++) {
    const el = makeContainer(`probe-editor-${i}`);
    const t0 = performance.now();
    const ed = monaco.editor.create(el, {
      value: TEXT,
      language: "plaintext",
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      lineNumbers: "off",
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      wordWrap: "on",
      automaticLayout: false,
    });
    const sync = performance.now() - t0;
    const frame = await nextFrame();
    creates.push({ index: i, create_ms: Number(sync.toFixed(1)), nextFrame_ms: Number(frame.toFixed(1)) });
    editors.push(ed);
  }
  result.createEditors = creates;
  const heapAfterCreate = heap();

  const ed = editors[0];
  const model = ed.getModel()!;

  // --- 2) 500 处 decorations（Monaco 方案的高亮成本） ---
  const t1 = performance.now();
  const collection = ed.createDecorationsCollection(
    makeRanges(model).map((range) => ({
      range,
      options: { inlineClassName: "probe-match", className: "probe-match-line" },
    })),
  );
  const decoSync = performance.now() - t1;
  const decoFrame = await nextFrame();
  result.decorations500 = {
    apply_ms: Number(decoSync.toFixed(1)),
    nextFrame_ms: Number(decoFrame.toFixed(1)),
    note: "createDecorationsCollection 一次性写入 500 条",
  };

  // --- 3) 增量更新（每次输入后重算高亮的典型路径） ---
  const t2 = performance.now();
  collection.set(
    makeRanges(model).map((range) => ({
      range,
      options: { inlineClassName: "probe-match2", className: "probe-match-line" },
    })),
  );
  const updSync = performance.now() - t2;
  const updFrame = await nextFrame();
  result.decorations500Update = {
    apply_ms: Number(updSync.toFixed(1)),
    nextFrame_ms: Number(updFrame.toFixed(1)),
  };

  // --- 4) setValue（测试文本整体替换，切换样本时的路径） ---
  const t3 = performance.now();
  model.setValue(TEXT + "\n" + TEXT.slice(0, 400));
  const setSync = performance.now() - t3;
  const setFrame = await nextFrame();
  result.setValue = { apply_ms: Number(setSync.toFixed(1)), nextFrame_ms: Number(setFrame.toFixed(1)) };

  // --- 5) 对照：span 覆盖层（500 个 span，纯 DOM 方案） ---
  const overlay = makeContainer("probe-overlay");
  overlay.style.whiteSpace = "pre-wrap";
  overlay.style.overflow = "auto";
  overlay.style.font = "12px monospace";
  const spans: string[] = [];
  const chars = TEXT.split("");
  for (let i = 0; i < chars.length; i++) spans.push(chars[i]);
  // 均匀插入 500 个高亮 span
  const step = Math.max(1, Math.floor(spans.length / MATCH_COUNT));
  let count = 0;
  for (let i = 0; i < spans.length && count < MATCH_COUNT; i += step) {
    spans[i] = `<span class="probe-match">${spans[i]}</span>`;
    count++;
  }
  const t4 = performance.now();
  overlay.innerHTML = spans.join("");
  void overlay.offsetHeight; // 强制布局
  const ovSync = performance.now() - t4;
  const ovFrame = await nextFrame();
  result.overlay500Spans = {
    apply_ms: Number(ovSync.toFixed(1)),
    nextFrame_ms: Number(ovFrame.toFixed(1)),
    injectedSpans: count,
  };

  // --- 6) dispose ---
  const t5 = performance.now();
  editors.forEach((e) => e.dispose());
  result.dispose3_ms = Number((performance.now() - t5).toFixed(1));

  const heapEnd = heap();
  result.heap = {
    before: heap0,
    afterCreate3: heapAfterCreate,
    end: heapEnd,
    delta3Editors_MB:
      heap0 && heapAfterCreate ? Number(((heapAfterCreate - heap0) / 1048576).toFixed(2)) : null,
  };

  const out = document.getElementById("out")!;
  out.textContent = JSON.stringify(result, null, 2);
  document.body.dataset.done = "1";
  (window as unknown as { __PROBE_RESULT__: unknown }).__PROBE_RESULT__ = result;
}

main().catch((e) => {
  const out = document.getElementById("out")!;
  out.textContent = JSON.stringify({ fatal: String(e && (e as Error).message ? (e as Error).message : e) }, null, 2);
  document.body.dataset.done = "1";
});
