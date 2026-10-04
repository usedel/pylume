// JSON 字面量扫描（P1 · 库支持 §7-3）纯函数用例：识别 / 反转义 / 诊断 / 重编码 / hover 摘要
import { describe, expect, it } from "vitest";
import { jsonHoverSummary, jsonParseError, pythonLiteralFor, scanJsonLiterals } from "../libJson";

describe("scanJsonLiterals（json.loads 字面量识别）", () => {
  it("双引号非 raw 串：识别 + 反转义（\\\" 与 \\n）", () => {
    const code = `data = json.loads("{\\"a\\": 1, \\"b\\": \\"x\\\\ny\\"}")`;
    const hits = scanJsonLiterals(code);
    expect(hits.length).toBe(1);
    expect(hits[0]!.value).toBe('{"a": 1, "b": "x\\ny"}'); // Python \\n → JSON \n 转义保留
    expect(hits[0]!.raw).toBe(false);
    expect(hits[0]!.triple).toBe(false);
    expect(hits[0]!.quote).toBe('"');
    expect(hits[0]!.start).toBe(code.indexOf('"'));
  });

  it("raw 串内容原样保留；三引号多行串识别并给出行号", () => {
    const raw = `r = json.loads(r"{'bad': trailing}")`;
    const rHits = scanJsonLiterals(raw);
    expect(rHits[0]!.value).toBe("{'bad': trailing}");
    expect(rHits[0]!.raw).toBe(true);

    const multi = 'x = json.loads("""{\n  "a": [1, 2]\n}""")';
    const mHits = scanJsonLiterals(multi);
    expect(mHits.length).toBe(1);
    expect(mHits[0]!.triple).toBe(true);
    expect(mHits[0]!.value).toBe('{\n  "a": [1, 2]\n}');
    expect(mHits[0]!.startLine).toBe(0);
    expect(mHits[0]!.endLine).toBe(2);
  });

  it("f-string / bytes / 非字符串实参不识别；单引号串支持", () => {
    expect(scanJsonLiterals('json.loads(f"{x}")').length).toBe(0);
    expect(scanJsonLiterals('json.loads(b"{}")').length).toBe(0);
    expect(scanJsonLiterals("json.loads(some_var)").length).toBe(0);
    const single = scanJsonLiterals("s = json.loads('{\"k\": true}')");
    expect(single.length).toBe(1);
    expect(single[0]!.value).toBe('{"k": true}');
    expect(single[0]!.quote).toBe("'");
  });

  it("对照组：普通字符串 / 非 json 模块调用不误报", () => {
    expect(scanJsonLiterals('msg = "json.loads 并不会调用自己"').length).toBe(0);
    expect(scanJsonLiterals('myjson.loads("{}")').length).toBe(0);
    expect(scanJsonLiterals('d = {"a": 1}').length).toBe(0);
  });
});

describe("jsonParseError / pythonLiteralFor", () => {
  it("合法 JSON 返回 null；非法返回带位置的错误", () => {
    expect(jsonParseError('{"a": 1}')).toBeNull();
    const err = jsonParseError('{"a": oops}');
    expect(err).not.toBeNull();
    expect(err!.pos).toBeGreaterThanOrEqual(0);
    expect(err!.message.length).toBeGreaterThan(0);
  });

  it("单行字面量重编码：转义兼容 Python 语法（引号/换行）", () => {
    const lit = pythonLiteralFor({ a: "x\ny", b: [1, 2] }, '"', false, 2);
    expect(lit.startsWith('"')).toBe(true);
    expect(lit.endsWith('"')).toBe(true);
    expect(lit).not.toContain("\n"); // 单行形态换行必须转义
    const back = scanJsonLiterals(`json.loads(${lit})`)[0]!;
    expect(JSON.parse(back.value)).toEqual({ a: "x\ny", b: [1, 2] });
  });

  it("三引号字面量重编码：保留真实换行；单引号形态同样可回读", () => {
    const lit = pythonLiteralFor({ a: 1 }, "'", true, 2);
    expect(lit.startsWith("'''")).toBe(true);
    const back = scanJsonLiterals(`json.loads(${lit})`)[0]!;
    expect(JSON.parse(back.value)).toEqual({ a: 1 });

    const sq = pythonLiteralFor({ "z": "它's fine" }, "'", false, 0);
    const backSq = scanJsonLiterals(`json.loads(${sq})`)[0]!;
    expect(JSON.parse(backSq.value)).toEqual({ z: "它's fine" });
  });
});

describe("jsonHoverSummary（§11.6 hover 摘要）", () => {
  it("object：顶层键数 + 嵌套深度（空容器算 1 层）", () => {
    expect(jsonHoverSummary('{"a": 1, "b": "x"}')).toBe("**JSON** · object · 2 键 · 1 层");
    expect(jsonHoverSummary('{"a": {"b": {"c": 1}}}')).toBe("**JSON** · object · 1 键 · 3 层");
    expect(jsonHoverSummary("{}")).toBe("**JSON** · object · 0 键 · 1 层");
  });

  it("array：项数；嵌套深度在 object 内；标量给类型；非法返回 null", () => {
    expect(jsonHoverSummary("[1, 2, 3]")).toBe("**JSON** · array · 3 项");
    expect(jsonHoverSummary("[]")).toBe("**JSON** · array · 0 项");
    expect(jsonHoverSummary('"hi"')).toBe("**JSON** · string");
    expect(jsonHoverSummary("42")).toBe("**JSON** · number");
    expect(jsonHoverSummary("true")).toBe("**JSON** · boolean");
    expect(jsonHoverSummary("null")).toBe("**JSON** · null");
    expect(jsonHoverSummary("{'bad': trailing}")).toBeNull();
  });
});
