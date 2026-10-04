// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { findMainGuardLine } from "../runGutter";

describe("findMainGuardLine __main__ 守卫检测", () => {
  it("命中常规双引号写法", () => {
    expect(findMainGuardLine('if __name__ == "__main__":\n    main()')).toBe(1);
  });

  it("命中带前导缩进", () => {
    expect(findMainGuardLine('  if __name__ == "__main__":')).toBe(1);
  });

  it("命中单引号写法", () => {
    expect(findMainGuardLine("if __name__ == '__main__':")).toBe(1);
  });

  it("忽略注释里的假匹配", () => {
    expect(findMainGuardLine('# if __name__ == "__main__":')).toBeNull();
  });

  it("无守卫返回 null", () => {
    expect(findMainGuardLine("def main():\n    pass")).toBeNull();
  });

  it("多守卫时取第一个", () => {
    const code = 'print(1)\nif __name__ == "__main__":\n    pass\nif __name__ == "__main__":\n    pass';
    expect(findMainGuardLine(code)).toBe(2);
  });
});