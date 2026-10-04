// PR-C（dx_features_backlog §6.3）：保存清理纯函数单测（saveCleanup.ts 无 DOM 依赖）。

import { describe, expect, it } from "vitest";
import { cleanupSaveContent } from "../saveCleanup";

const BOTH = { trimTrailing: true, finalNewline: true };

describe("cleanupSaveContent 行尾空白", () => {
  it("剥行尾空格与 Tab，行内空白保留", () => {
    expect(cleanupSaveContent("alpha = 1   \nx = (1,  2) \t\n", BOTH)).toBe("alpha = 1\nx = (1,  2)\n");
  });

  it("空行上的空白同样剥除", () => {
    expect(cleanupSaveContent("a = 1\n   \nb = 2\n", { trimTrailing: true, finalNewline: false })).toBe(
      "a = 1\n\nb = 2\n",
    );
  });

  it("关闭 trimTrailing 时不动行尾", () => {
    expect(cleanupSaveContent("a = 1   \n", { trimTrailing: false, finalNewline: true })).toBe("a = 1   \n");
  });
});

describe("cleanupSaveContent 最终换行", () => {
  it("缺最终换行时补一个", () => {
    expect(cleanupSaveContent("a = 1\nb = 2", { trimTrailing: false, finalNewline: true })).toBe("a = 1\nb = 2\n");
  });

  it("已以换行结束则不动（不折叠结尾多余空行）", () => {
    const src = "a = 1\n\n\n";
    expect(cleanupSaveContent(src, BOTH)).toBe(src);
  });

  it("空文件不动（不写成单个换行）", () => {
    expect(cleanupSaveContent("", BOTH)).toBe("");
  });

  it("仅含行尾空白且无换行的文件：trim 后仍补换行", () => {
    expect(cleanupSaveContent("a = 1   ", BOTH)).toBe("a = 1\n");
  });
});

describe("cleanupSaveContent EOL 与幂等", () => {
  it("CRLF 文件：行尾空白剥除且 EOL 保持 \\r\\n", () => {
    expect(cleanupSaveContent("a = 1  \r\nb = 2", BOTH)).toBe("a = 1\r\nb = 2\r\n");
  });

  it("幂等：已干净的文件原样返回", () => {
    const src = "a = 1\nb = 2\n";
    expect(cleanupSaveContent(src, BOTH)).toBe(src);
  });

  it("两个开关全关时原样返回（不再走 split/join 归一 EOL）", () => {
    const src = "a = 1   \r\nb\r\n";
    expect(cleanupSaveContent(src, { trimTrailing: false, finalNewline: false })).toBe(src);
  });
});
