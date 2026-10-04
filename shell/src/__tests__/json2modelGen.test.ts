// JSON→Python 模型生成器（P1 · 库支持 §7-2）纯函数用例：类型推断 / 嵌套类 / 别名 / 三形态
import { describe, expect, it } from "vitest";
import { jsonToModelCode, toIdentifier, toPascal } from "../devtools/builtin/json2model.gen";

describe("toIdentifier / toPascal（标识符合法化）", () => {
  it("非法字符折叠、数字开头补 _、关键字补尾 _、空串兜底", () => {
    expect(toIdentifier("user-name")).toBe("user_name");
    expect(toIdentifier("2fa")).toBe("_2fa");
    expect(toIdentifier("class")).toBe("class_");
    expect(toIdentifier("a b!")).toBe("a_b_");
    expect(toIdentifier("")).toBe("_");
    expect(toPascal("user_name")).toBe("UserName");
    expect(toPascal("")).toBe("Model");
  });
});

describe("jsonToModelCode · Pydantic（默认形态）", () => {
  it("标量类型推断：bool / int / float / str + 空列表 List[Any] + null → Any 默认 None", () => {
    const code = jsonToModelCode(
      JSON.stringify({ name: "Alice", age: 30, active: true, score: 9.5, tags: [], nickname: null }),
    );
    expect(code).toBe(
      [
        "from typing import Any, List",
        "from pydantic import BaseModel",
        "",
        "class Model(BaseModel):",
        "    name: str",
        "    age: int",
        "    active: bool",
        "    score: float",
        "    tags: List[Any]",
        "    nickname: Any = None",
        "",
      ].join("\n"),
    );
  });

  it("嵌套对象 → 独立模型类，且被引用类先于引用方输出", () => {
    const code = jsonToModelCode(JSON.stringify({ user: { id: 1 }, name: "x" }));
    expect(code).toBe(
      [
        "from pydantic import BaseModel",
        "",
        "class User(BaseModel):",
        "    id: int",
        "",
        "class Model(BaseModel):",
        "    user: User",
        "    name: str",
        "",
      ].join("\n"),
    );
  });

  it("非法标识符 key → 改名 + Field(alias=…)；关键字 key 同样处理", () => {
    const code = jsonToModelCode(JSON.stringify({ "user-name": "x", class: 1 }));
    expect(code).toBe(
      [
        "from pydantic import BaseModel, Field",
        "",
        "class Model(BaseModel):",
        '    user_name: str = Field(alias="user-name")',
        '    class_: int = Field(alias="class")',
        "",
      ].join("\n"),
    );
  });

  it("列表：同质 → List[T]；对象元素带出 Item 类；混合 → List[Any]；空 dict → pass 类体", () => {
    expect(jsonToModelCode('[{"x": 1}]')).toBe(
      [
        "from typing import List",
        "from pydantic import BaseModel",
        "",
        "class ModelItem(BaseModel):",
        "    x: int",
        "",
        "Model = List[ModelItem]",
        "",
      ].join("\n"),
    );
    expect(jsonToModelCode(JSON.stringify({ meta: {}, nums: [1, "a"], mixed: [1, null] }))).toBe(
      [
        "from typing import Any, List, Union",
        "from pydantic import BaseModel",
        "",
        "class Meta(BaseModel):",
        "    pass",
        "",
        "class Model(BaseModel):",
        "    meta: Meta",
        "    nums: List[Union[int, str]]",
        "    mixed: List[Any]",
        "",
      ].join("\n"),
    );
  });

  it("根为标量 → 类型别名；rootName 自定义类名", () => {
    expect(jsonToModelCode("5", { rootName: "answer" })).toBe("Answer = int\n");
    expect(jsonToModelCode('["a"]', { rootName: "names" })).toBe(
      ["from typing import List", "", "Names = List[str]", ""].join("\n"),
    );
  });

  it("非法 JSON 原样抛 SyntaxError", () => {
    expect(() => jsonToModelCode("{oops")).toThrow(SyntaxError);
  });
});

describe("jsonToModelCode · dataclass / TypedDict 形态", () => {
  it("dataclass：dataclasses 头 + null 默认 None + 无别名机制（仅合法化改名）", () => {
    const code = jsonToModelCode(JSON.stringify({ "user-name": "x", nickname: null }), { style: "dataclass" });
    expect(code).toBe(
      [
        "from typing import Any",
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class Model:",
        "    user_name: str",
        "    nickname: Any = None",
        "",
      ].join("\n"),
    );
  });

  it("TypedDict：typing 头 + 非法 key 用带引号的字符串字面量", () => {
    const code = jsonToModelCode(JSON.stringify({ ok: true, "user-name": "x" }), { style: "typeddict" });
    expect(code).toBe(
      [
        "from typing import TypedDict",
        "",
        "class Model(TypedDict):",
        "    ok: bool",
        '    "user-name": str',
        "",
      ].join("\n"),
    );
  });
});
