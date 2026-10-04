import { describe, expect, it } from "vitest";
import { isPydanticFieldDecl } from "../pydanticField";

const MODEL = [
  "from pydantic import BaseModel",
  "",
  "class User(BaseModel):",
  "    id: int",
  "    name: str = \"a\"",
  "    is_active: bool = Field(default=True)",
  "",
  "    def greet(self) -> str:",
  "        return self.name",
  "",
  "u = User(id=1, name=\"x\")",
];

describe("isPydanticFieldDecl（Pydantic 字段声明识别，阶段 2）", () => {
  it("BaseModel 子类的注解字段命中（无默认值 / 有默认值 / Field(...)）", () => {
    expect(isPydanticFieldDecl(MODEL, 3, 4)).toBe(true); // id: int
    expect(isPydanticFieldDecl(MODEL, 4, 4)).toBe(true); // name: str = "a"
    expect(isPydanticFieldDecl(MODEL, 5, 8)).toBe(true); // is_active: bool = Field(default=True)
  });

  it("普通类字段不命中（基类列表无 BaseModel）", () => {
    const src = ["class Plain:", "    x: int = 1", ""];
    expect(isPydanticFieldDecl(src, 1, 4)).toBe(false);
  });

  it("顶格 def 截断向上搜索：def 之后的字段行不再归属上方类", () => {
    const src = ["class M(BaseModel):", "    a: int", "", "def f():", "    x: int = 1"];
    expect(isPydanticFieldDecl(src, 4, 4)).toBe(false);
  });

  it("类体内缩进 def 不截断（字段在方法之后仍可命中后续类）", () => {
    const src = [
      "class A:", // 普通类
      "    def m(self):",
      "        pass",
      "",
      "class B(BaseModel):",
      "    y: str",
    ];
    // 行 5 是 B 的字段：向上先遇到行 4 的 class B（BaseModel）→ 命中
    expect(isPydanticFieldDecl(src, 5, 4)).toBe(true);
  });

  it("非字段行（类头 / 普通语句 / 空行）不命中", () => {
    expect(isPydanticFieldDecl(MODEL, 2, 6)).toBe(false); // class User(BaseModel):
    expect(isPydanticFieldDecl(MODEL, 10, 0)).toBe(false); // u = User(...)
    expect(isPydanticFieldDecl(MODEL, 1, 0)).toBe(false); // 空行
  });

  it("多基类 / 模块限定基类写法命中", () => {
    const src = [
      "import pydantic",
      "class C(pydantic.BaseModel, Mixin):",
      "    k: int",
    ];
    expect(isPydanticFieldDecl(src, 2, 4)).toBe(true);
  });

  it("越界参数返回 false", () => {
    expect(isPydanticFieldDecl(MODEL, -1, 0)).toBe(false);
    expect(isPydanticFieldDecl(MODEL, 999, 0)).toBe(false);
    expect(isPydanticFieldDecl(MODEL, 3, -1)).toBe(false);
  });
});
