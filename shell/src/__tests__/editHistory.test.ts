// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { eventAt, LineCollector } from "../editHistory";

/** 最小行源码桩：只实现 eventAt 用到的三个方法。 */
function fakeSource(lines: string[], lang = "python") {
  return {
    getLanguageId: () => lang,
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? "",
  };
}

describe("LineCollector 行定型状态机", () => {
  it("光标换行时把 dirty 旧行定型", () => {
    const c = new LineCollector();
    c.reset(1); // 锚定光标初始在第 1 行
    c.changed(1, 1); // 第 1 行被编辑
    expect(c.cursorMoved(2)).toBe(1); // 移到第 2 行 → 定型第 1 行
    expect(c.cursorMoved(3)).toBeNull(); // 第 2 行未编辑，不采
  });

  it("同一行内移动不触发（未离开）", () => {
    const c = new LineCollector();
    c.reset(1);
    c.changed(1, 1);
    expect(c.cursorMoved(1)).toBeNull(); // 没离开第 1 行
    expect(c.cursorMoved(2)).toBe(1); // 这时才离开，采第 1 行
  });

  it("未编辑的行即使离开也不采", () => {
    const c = new LineCollector();
    c.reset(1);
    c.changed(2, 2); // 只有第 2 行脏
    expect(c.cursorMoved(2)).toBeNull(); // 从 1 移到 2，但第 1 行不脏
    expect(c.cursorMoved(3)).toBe(2); // 从 2 移到 3，第 2 行脏 → 采
  });

  it("reset 清空 dirty 并锚定新基线", () => {
    const c = new LineCollector();
    c.reset(1);
    c.changed(1, 1);
    c.cursorMoved(2); // 采第 1 行，lastLine=2
    c.reset(2); // 锚定第 2 行，清 dirty
    expect(c.cursorMoved(3)).toBeNull(); // 第 2 行已不脏
  });
});

describe("eventAt 行对提取", () => {
  it("提取缩进 + 上一非空行", () => {
    const m = fakeSource(['data = parse_page(html)', '    print(data["title"])']);
    const ev = eventAt(1000, m, 2);
    expect(ev).not.toBeNull();
    expect(ev!.line).toBe('print(data["title"])');
    expect(ev!.indent).toBe(4);
    expect(ev!.prev).toBe("data = parse_page(html)");
    expect(ev!.lang).toBe("python");
  });

  it("空行往上跳过找上一非空行", () => {
    const m = fakeSource(["a = 1", "", "b = 2"]);
    expect(eventAt(1000, m, 3)!.prev).toBe("a = 1");
  });

  it("纯空白行不采集", () => {
    const m = fakeSource(["   "]);
    expect(eventAt(1000, m, 1)).toBeNull();
  });

  it("非 python 不采集", () => {
    const m = fakeSource(["x = 1"], "rust");
    expect(eventAt(1000, m, 1)).toBeNull();
  });

  it("越界行号返回 null", () => {
    const m = fakeSource(["x = 1"]);
    expect(eventAt(1000, m, 0)).toBeNull();
    expect(eventAt(1000, m, 2)).toBeNull();
  });
});