// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parsePycharmXml, translatePycharmContext, translatePycharmExpression } from "../pycharmImport";

describe("translatePycharmExpression", () => {
  it("同名函数原样保留", () => {
    expect(translatePycharmExpression('concat(fileName(), " — ", date("yyyy-MM-dd"))')).toBe(
      'concat(fileName(), " — ", date("yyyy-MM-dd"))',
    );
    expect(translatePycharmExpression('enum("A", "B")')).toBe('enum("A", "B")');
  });
  it("映射表重命名", () => {
    expect(translatePycharmExpression('lowercaseAndDash("FooBar")')).toBe('kebabCase("FooBar")');
    expect(translatePycharmExpression("completeSmart()")).toBe("complete()");
    expect(translatePycharmExpression("classNameComplete()")).toBe("complete()");
  });
  it("不支持的函数 → null（调用方降级为默认值）", () => {
    expect(translatePycharmExpression('groovyScript("_1.toUpperCase()", X)')).toBeNull();
    expect(translatePycharmExpression("expectedType()")).toBeNull();
    expect(translatePycharmExpression("djangoBlock()")).toBeNull();
  });
  it("非法表达式 → null", () => {
    expect(translatePycharmExpression("foo(")).toBeNull();
  });
});

describe("parsePycharmXml", () => {
  const XML = `<templateSet group="Python">
  <template name="logf" value="logger.info(&quot;$MSG$&quot;)$END$" description="log">
    <variable name="MSG" expression="" defaultValue="&quot;hello&quot;" alwaysStopAt="true" />
  </template>
  <template name="hdr" value="# $F$ $D$" description="">
    <variable name="F" expression="fileName()" defaultValue="&quot;&quot;" alwaysStopAt="false" />
    <variable name="D" expression="groovyScript(&quot;x&quot;)" defaultValue="&quot;X&quot;" alwaysStopAt="true" />
  </template>
  <template name="bad abbr!" value="x" description="" />
</templateSet>`;

  it("解析模板/变量/降级/错误分流", () => {
    const result = parsePycharmXml(XML);
    expect(result).not.toBeNull();
    expect(result!.templates.map((t) => t.abbreviation)).toEqual(["logf", "hdr"]);
    expect(result!.errors).toHaveLength(1);

    const logf = result!.templates[0];
    expect(logf.body).toBe('logger.info("$MSG$")$END$'); // XML 实体已解码
    expect(logf.variables).toEqual([
      { name: "MSG", expression: undefined, defaultValue: "hello", skipIfDefined: false },
    ]);
    expect(logf.scopes).toEqual(["python:module", "python:class", "python:function"]);
    expect(logf.tabExpand).toBe(true);

    const hdr = result!.templates[1];
    // fileName() 可翻译保留；alwaysStopAt=false → skipIfDefined
    expect(hdr.variables?.[0]).toEqual({
      name: "F",
      expression: "fileName()",
      defaultValue: undefined,
      skipIfDefined: true,
    });
    // groovyScript 不支持 → 降级：表达式去除、默认值保留、记录待人工确认
    expect(hdr.variables?.[1]).toEqual({
      name: "D",
      expression: undefined,
      defaultValue: "X",
      skipIfDefined: false,
    });
    expect(result!.downgraded).toEqual([
      { abbreviation: "hdr", variable: "D", expression: 'groovyScript("x")' },
    ]);
  });

  it("非 XML / 无模板 → null 或空集", () => {
    expect(parsePycharmXml("not xml at all <<<")?.templates ?? []).toEqual([]);
    expect(parsePycharmXml("<templateSet></templateSet>")!.templates).toEqual([]);
  });
});

describe("translatePycharmContext（相位 B：<context> → 容器 + 位置）", () => {
  const o = (name: string, value: boolean): { name: string; value: boolean } => ({ name, value });

  it("TOP_LEVEL_STATEMENT → module 容器 + 语句位", () => {
    expect(translatePycharmContext([o("PYTHON_TOP_LEVEL_STATEMENT", true)])).toEqual({
      scopes: ["python:module"],
      positions: ["statement"],
      unknown: [],
    });
  });

  it("TOP_LEVEL + EXPRESSION → 两位置都保留", () => {
    expect(
      translatePycharmContext([o("PYTHON_TOP_LEVEL_STATEMENT", true), o("PYTHON_EXPRESSION", true)]),
    ).toEqual({ scopes: ["python:module"], positions: ["statement", "expression"], unknown: [] });
  });

  it("STATEMENT / EXPRESSION 单独或组合", () => {
    expect(translatePycharmContext([o("PYTHON_STATEMENT", true)])).toEqual({
      positions: ["statement"],
      unknown: [],
    });
    expect(translatePycharmContext([o("PYTHON_EXPRESSION", true)])).toEqual({
      positions: ["expression"],
      unknown: [],
    });
    expect(translatePycharmContext([o("PYTHON_STATEMENT", true), o("PYTHON_EXPRESSION", true)])).toEqual({
      positions: ["statement", "expression"],
      unknown: [],
    });
  });

  it("false 选项不计入；全 false → 回落缺省（positions undefined）", () => {
    expect(translatePycharmContext([o("PYTHON_STATEMENT", false)])).toEqual({ positions: undefined, unknown: [] });
    expect(
      translatePycharmContext([o("PYTHON_STATEMENT", false), o("PYTHON_EXPRESSION", false)]),
    ).toEqual({ positions: undefined, unknown: [] });
  });

  it("未知选项（true）记录 unknown；未知（false）忽略", () => {
    expect(translatePycharmContext([o("PYTHON_STATEMENT", true), o("PYTHON_COMMENT", true)])).toEqual({
      positions: ["statement"],
      unknown: ["PYTHON_COMMENT"],
    });
    expect(translatePycharmContext([o("PYTHON_COMMENT", false)])).toEqual({ positions: undefined, unknown: [] });
  });
});

describe("parsePycharmXml <context> 导入（相位 B）", () => {
  it("TOP_LEVEL_STATEMENT 保真为 module + statement", () => {
    const xml = `<templateSet group="Python">
      <template name="main2" value="main" description="">
        <context>
          <option name="PYTHON_TOP_LEVEL_STATEMENT" value="true" />
          <option name="PYTHON_EXPRESSION" value="false" />
        </context>
      </template>
    </templateSet>`;
    const result = parsePycharmXml(xml)!;
    expect(result.templates[0].scopes).toEqual(["python:module"]);
    expect(result.templates[0].positions).toEqual(["statement"]);
  });

  it("无 <context> → 缺省三容器 + 不写 positions", () => {
    const xml = `<templateSet><template name="plain" value="x" description="" /></templateSet>`;
    const result = parsePycharmXml(xml)!;
    expect(result.templates[0].scopes).toEqual(["python:module", "python:class", "python:function"]);
    expect(result.templates[0].positions).toBeUndefined();
  });

  it("未知 context 选项进 downgraded（不整体失败）", () => {
    const xml = `<templateSet>
      <template name="weird" value="x" description="">
        <context>
          <option name="PYTHON_STATEMENT" value="true" />
          <option name="OTHER_CONTEXT" value="true" />
        </context>
      </template>
    </templateSet>`;
    const result = parsePycharmXml(xml)!;
    expect(result.templates[0].positions).toEqual(["statement"]);
    expect(result.downgraded).toContainEqual({ abbreviation: "weird", variable: "<context>", expression: "OTHER_CONTEXT" });
  });
});
