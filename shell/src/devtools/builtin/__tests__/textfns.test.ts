// v1.1 工具纯函数测试（textfns.ts）：标准向量 + 往返 + 边界行为钉死。
// 密码/洗牌类随机函数测「分布性质与约束」而非具体值。

import { describe, expect, it } from "vitest";
import {
  bigIntToRadix, diffLines, formatDiff, generatePassword, hexToRgbAlias, hslToRgb, htmlDecode, htmlEncode,
  parseHexColor, parseRadixInput, radixAllFormats, rgbToAnsi256, rgbToHex, rgbToHsl, secureRandomInt,
  selectionToHex, sortLines, textStats, transformCase, unicodeEscape, unicodeUnescape,
} from "../textfns";

// ---------- 进制 ----------

describe("parseRadixInput", () => {
  it("十进制（含负数与下划线分隔）", () => {
    expect(parseRadixInput("255")).toBe(255n);
    expect(parseRadixInput("-42")).toBe(-42n);
    expect(parseRadixInput("1_000_000")).toBe(1000000n);
  });
  it("前缀形式", () => {
    expect(parseRadixInput("0xFF")).toBe(255n);
    expect(parseRadixInput("0Xff")).toBe(255n);
    expect(parseRadixInput("0b1010")).toBe(10n);
    expect(parseRadixInput("0o17")).toBe(15n);
  });
  it("超 Number.MAX_SAFE_INTEGER 精度无损", () => {
    expect(parseRadixInput("9007199254740993")).toBe(9007199254740993n);
  });
  it("非法输入返回 null", () => {
    expect(parseRadixInput("")).toBeNull();
    expect(parseRadixInput("abc")).toBeNull();
    expect(parseRadixInput("0x")).toBeNull();
    expect(parseRadixInput("12.5")).toBeNull();
  });
});

describe("radixAllFormats / bigIntToRadix", () => {
  it("255 → 四进制全景", () => {
    expect(radixAllFormats("255")).toEqual({ bin: "11111111", oct: "377", dec: "255", hex: "ff" });
  });
  it("0x 前缀输入同样识别", () => {
    expect(radixAllFormats("0xff")!.hex).toBe("ff");
    expect(radixAllFormats("0b1010")!.dec).toBe("10");
  });
  it("负数带符号", () => {
    expect(bigIntToRadix(-255n, 16)).toBe("-ff");
  });
  it("非法返回 null", () => {
    expect(radixAllFormats("zzz")).toBeNull();
  });
});

describe("selectionToHex（inline）", () => {
  it("十进制选区 → 0x 前缀", () => {
    expect(selectionToHex("255")).toBe("0xff");
    expect(selectionToHex(" 4096 ")).toBe("0x1000");
  });
  it("0x 输入原样规范化（小写）", () => {
    expect(selectionToHex("0XAB")).toBe("0xab");
  });
  it("非法抛错（保留原文语义）", () => {
    expect(() => selectionToHex("hello")).toThrow();
  });
});

// ---------- HTML 实体 ----------

describe("htmlEncode / htmlDecode", () => {
  it("五命名实体", () => {
    expect(htmlEncode(`<a href="x">&'`)).toBe(`&lt;a href=&quot;x&quot;&gt;&amp;&apos;`);
    expect(htmlDecode(htmlEncode(`<a href="x">&'`))).toBe(`<a href="x">&'`);
  });
  it("非 ASCII → 数字实体", () => {
    expect(htmlEncode("中文")).toBe("&#20013;&#25991;");
    expect(htmlDecode("&#20013;&#25991;")).toBe("中文");
  });
  it("十六进制数字实体", () => {
    expect(htmlDecode("&#x4e2d;")).toBe("中");
  });
  it("emoji（BMP 外）数字实体往返", () => {
    const e = htmlEncode("👍");
    expect(e).toBe("&#128077;");
    expect(htmlDecode(e)).toBe("👍");
  });
  it("未知实体原样保留", () => {
    expect(htmlDecode("&nbsp;&unknown;")).toBe("&nbsp;&unknown;");
  });
  it("代理区非法码点不炸（返回原文）", () => {
    expect(htmlDecode("&#xD800;")).toBe("&#xD800;");
  });
});

// ---------- Unicode ⇄ 明文 ----------

describe("unicodeEscape / unicodeUnescape", () => {
  it("BMP：中 → \\u4e2d", () => {
    expect(unicodeEscape("中")).toBe("\\u4e2d");
    expect(unicodeUnescape("\\u4e2d")).toBe("中");
  });
  it("非 BMP：代理对拆分（Python repr 形态）", () => {
    expect(unicodeEscape("👍")).toBe("\\ud83d\\udc4d");
    expect(unicodeUnescape("\\ud83d\\udc4d")).toBe("👍");
  });
  it("\\u{...} 形式（Rust/JS 形态）", () => {
    expect(unicodeUnescape("\\u{1F44D}")).toBe("👍");
  });
  it("混合文本往返", () => {
    const s = "你好 world 123";
    expect(unicodeUnescape(unicodeEscape(s))).toBe(s);
  });
  it("ASCII 不转义（escape 只处理非 ASCII？——否：全量转义）", () => {
    // 设计取舍：escape 是「全量转义」（把整段变 \\uXXXX 串便于嵌入代码），ASCII 也转
    expect(unicodeEscape("a")).toBe("\\u0061");
  });
});

// ---------- 大小写 ----------

describe("transformCase", () => {
  it("upper / lower", () => {
    expect(transformCase("Hello", "upper")).toBe("HELLO");
    expect(transformCase("Hello", "lower")).toBe("hello");
  });
  it("title：每词首字母大写", () => {
    expect(transformCase("hello world", "title")).toBe("Hello World");
    expect(transformCase("HELLO-WORLD", "title")).toBe("Hello-World");
  });
  it("snake：空格/连字符 → 下划线 + 驼峰拆分", () => {
    expect(transformCase("Hello World", "snake")).toBe("hello_world");
    expect(transformCase("camelCase-Text", "snake")).toBe("camel_case_text");
  });
  it("camel：小驼峰", () => {
    expect(transformCase("hello world", "camel")).toBe("helloWorld");
    expect(transformCase("HTTP_SERVER_NAME", "camel")).toBe("httpServerName");
  });
  it("中文不受影响（无大小写）", () => {
    expect(transformCase("你好", "upper")).toBe("你好");
  });
});

// ---------- 字数统计 ----------

describe("textStats", () => {
  it("空串", () => {
    expect(textStats("")).toEqual({ chars: 0, charsNoSpace: 0, words: 0, cjk: 0, lines: 0 });
  });
  it("英文词计数", () => {
    const s = textStats("hello world");
    expect(s.words).toBe(2);
    expect(s.chars).toBe(11);
    expect(s.charsNoSpace).toBe(10);
  });
  it("中文按字计 CJK（words 视连续汉字为一个词——无分词）", () => {
    const s = textStats("你好世界");
    expect(s.cjk).toBe(4);
    expect(s.words).toBe(1);
  });
  it("行数（\\n 与 \\r\\n）", () => {
    expect(textStats("a\nb\nc").lines).toBe(3);
    expect(textStats("a\r\nb").lines).toBe(2);
  });
  it("emoji 按码点计数（不按 UTF-16 单元）", () => {
    expect(textStats("👍").chars).toBe(1);
  });
});

// ---------- 排序去重 ----------

describe("sortLines", () => {
  it("升序（数字自然序）", () => {
    expect(sortLines("10\n2\n1", "asc")).toBe("1\n2\n10");
  });
  it("降序", () => {
    expect(sortLines("1\n2\n3", "desc")).toBe("3\n2\n1");
  });
  it("reverse 保序倒置", () => {
    expect(sortLines("a\nb\nc", "reverse")).toBe("c\nb\na");
  });
  it("去重（排序模式下相邻去重）", () => {
    expect(sortLines("b\na\nb\na", "asc", { dedupe: true })).toBe("a\nb");
  });
  it("非排序模式下去重（Set 保序 = 变换后的首现序）", () => {
    expect(sortLines("b\na\nb", "reverse", { dedupe: true })).toBe("b\na");
  });
  it("忽略大小写去重", () => {
    expect(sortLines("A\na\nB", "asc", { dedupe: true, caseSensitive: false })).toBe("A\nB");
  });
  it("去空行", () => {
    expect(sortLines("a\n\nb\n", "asc", { keepEmpty: false })).toBe("a\nb");
  });
  it("shuffle：元素多重集不变", () => {
    const src = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const out = sortLines(src, "shuffle");
    expect(out.split("\n").sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });
  it("CRLF 归一", () => {
    expect(sortLines("b\r\na", "asc")).toBe("a\nb");
  });
});

describe("secureRandomInt", () => {
  it("值域 [0, n)", () => {
    for (let i = 0; i < 200; i++) {
      const v = secureRandomInt(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });
  it("n=1 恒 0", () => {
    expect(secureRandomInt(1)).toBe(0);
  });
  it("非法 n 抛错", () => {
    expect(() => secureRandomInt(0)).toThrow();
    expect(() => secureRandomInt(-1)).toThrow();
  });
});

// ---------- 颜色 ----------

describe("parseHexColor / rgbToHex", () => {
  it("#rrggbb", () => {
    expect(parseHexColor("#FF8000")).toEqual([255, 128, 0]);
  });
  it("#rgb（短形式展开）", () => {
    expect(parseHexColor("#f80")).toEqual([255, 136, 0]);
  });
  it("#rrggbbaa 忽略 alpha", () => {
    expect(parseHexColor("#ff800080")).toEqual([255, 128, 0]);
  });
  it("非法形态返回 null", () => {
    expect(parseHexColor("ff8000")).toBeNull(); // 缺 #
    expect(parseHexColor("#ff80")).toBeNull(); // 4 位
    expect(parseHexColor("#zzzzzz")).toBeNull();
  });
  it("rgbToHex 往返 + 钳位", () => {
    expect(rgbToHex(255, 128, 0)).toBe("#ff8000");
    expect(rgbToHex(300, -5, 0)).toBe("#ff0000");
  });
});

describe("rgbToHsl / hslToRgb", () => {
  it("红色：#ff0000 → hsl(0,100%,50%)", () => {
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 100, l: 50 });
  });
  it("白色 s=0", () => {
    expect(rgbToHsl(255, 255, 255)).toEqual({ h: 0, s: 0, l: 100 });
  });
  it("hsl → rgb 红色", () => {
    expect(hslToRgb(0, 100, 50)).toEqual([255, 0, 0]);
  });
  it("往返近似（四舍五入 ±1 容差）", () => {
    const rgb: [number, number, number] = [66, 135, 245];
    const hsl = rgbToHsl(...rgb);
    const back = hslToRgb(hsl.h, hsl.s, hsl.l);
    back.forEach((v, i) => expect(Math.abs(v - rgb[i])).toBeLessThanOrEqual(1));
  });
});

describe("rgbToAnsi256", () => {
  it("纯黑 → 16（立方体原点）", () => {
    expect(rgbToAnsi256(0, 0, 0)).toBe(16);
  });
  it("纯白 → 231（立方体顶点）", () => {
    expect(rgbToAnsi256(255, 255, 255)).toBe(231);
  });
  it("主色映射稳定", () => {
    expect(rgbToAnsi256(255, 0, 0)).toBe(196);
    expect(rgbToAnsi256(0, 255, 0)).toBe(46);
  });
});

// ---------- 密码 ----------

describe("generatePassword", () => {
  it("长度与字符集约束", () => {
    const p = generatePassword({ length: 20, lower: true, upper: true, digits: true, symbols: true, excludeSimilar: false });
    expect(p).toHaveLength(20);
    expect(p).toMatch(/[a-z]/);
    expect(p).toMatch(/[A-Z]/);
    expect(p).toMatch(/[0-9]/);
    expect(p).toMatch(/[!@#$%^&*()\-_=+\[\]{};:,.<>?/~]/);
  });
  it("excludeSimilar 排除易混字符", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 16, lower: true, upper: true, digits: true, symbols: false, excludeSimilar: true });
      expect(p).not.toMatch(/[il1Lo0O`'"|]/);
    }
  });
  it("每类选中集合至少 1 字符", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 8, lower: true, upper: false, digits: true, symbols: false, excludeSimilar: false });
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
    }
  });
  it("全不选抛错", () => {
    expect(() => generatePassword({ length: 8, lower: false, upper: false, digits: false, symbols: false, excludeSimilar: false })).toThrow();
  });
  it("非法长度抛错", () => {
    expect(() => generatePassword({ length: 3, lower: true, upper: false, digits: false, symbols: false, excludeSimilar: false })).toThrow();
    expect(() => generatePassword({ length: 999, lower: true, upper: false, digits: false, symbols: false, excludeSimilar: false })).toThrow();
  });
});

// ---------- Diff ----------

describe("diffLines / formatDiff", () => {
  it("完全相同 → 全 = 行", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d).toEqual([{ type: "=", text: "a" }, { type: "=", text: "b" }]);
  });
  it("纯新增", () => {
    const d = diffLines("a", "a\nb");
    expect(d).toEqual([{ type: "=", text: "a" }, { type: "+", text: "b" }]);
  });
  it("纯删除", () => {
    const d = diffLines("a\nb", "a");
    expect(d).toEqual([{ type: "=", text: "a" }, { type: "-", text: "b" }]);
  });
  it("修改（- 旧 + 新）", () => {
    const d = diffLines("x\nold\ny", "x\nnew\ny");
    expect(d).toEqual([
      { type: "=", text: "x" },
      { type: "-", text: "old" },
      { type: "+", text: "new" },
      { type: "=", text: "y" },
    ]);
  });
  it("空串对比（split 得 ['']，空行为内容行）", () => {
    const d = diffLines("", "a");
    expect(d).toEqual([{ type: "-", text: "" }, { type: "+", text: "a" }]);
  });
  it("formatDiff 前缀", () => {
    expect(formatDiff([{ type: "+", text: "a" }, { type: "-", text: "b" }, { type: "=", text: "c" }])).toBe("+ a\n- b\n  c");
  });
  it("超限抛错", () => {
    expect(() => diffLines("a\n".repeat(6000), "b\n".repeat(6000))).toThrow();
  });
});

// ---------- hexToRgbAlias（面板布局用别名，防导入遗漏） ----------

describe("hexToRgbAlias", () => {
  it("等价 parseHexColor", () => {
    expect(hexToRgbAlias("#ff8000")).toEqual(parseHexColor("#ff8000"));
  });
});
