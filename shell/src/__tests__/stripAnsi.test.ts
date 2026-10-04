// v3.4 §11（M3-3.8）：运行历史采集的 ANSI 剥离单测（纯函数，实现在 util.ts）。
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../util";

describe("stripAnsi（§11 历史采集剥离 ANSI；失败降级原样入档）", () => {
  it("CSI 颜色序列剥离，正文保留", () => {
    expect(stripAnsi("\x1b[33m警告文本\x1b[0m")).toBe("警告文本");
  });

  it("进度条回车形态（\\r + CSI 清行）剥离", () => {
    expect(stripAnsi("50%\r\x1b[K100%\r\x1b[Kdone")).toBe("50%100%done");
  });

  it("OSC 超链接序列（BEL / ST 终止）剥离", () => {
    expect(stripAnsi("\x1b]8;;http://x\x07link\x1b]8;;\x07")).toBe("link");
    expect(stripAnsi("\x1b]0;title\x1b\\body")).toBe("body");
  });

  it("单字符转义与 C0 控制字符剥离（保留换行）", () => {
    expect(stripAnsi("a\x1b=b\tc\x07")).toBe("abc");
    expect(stripAnsi("line1\nline2")).toBe("line1\nline2");
  });

  it("纯文本原样通过（traceback 帧不受影响）", () => {
    expect(stripAnsi('File "main.py", line 3')).toBe('File "main.py", line 3');
  });
});
