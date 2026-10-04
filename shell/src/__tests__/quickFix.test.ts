// 自研快速修复纯函数单测（P4 · D-1/D-2 + D-4 的 noqa 行构造）
// 全部为无副作用纯函数（不经 Monaco/invoke），对齐 live-templates 引擎测试范式。
import { describe, expect, it } from "vitest";
import {
  buildCreateStub,
  extractUndefinedName,
  findImportInsertLine,
  findModuleHeaderEnd,
  inferCallArity,
  isSuppressedEngineAction,
  scanTopLevelSymbol,
} from "../quickFix";
import { buildNoqaLine, normalizeSeverity } from "../ruffLint";

describe("extractUndefinedName（诊断文案 → 未定义名字）", () => {
  it("覆盖 pyrefly / basedpyright / ruff F821 常见句式", () => {
    expect(extractUndefinedName("Undefined name `helper`")).toBe("helper");
    expect(extractUndefinedName('Undefined name "helper"')).toBe("helper");
    expect(extractUndefinedName("`helper` is not defined")).toBe("helper");
    expect(extractUndefinedName('Name "helper" is not defined')).toBe("helper");
    expect(extractUndefinedName("name helper is not defined")).toBe("helper");
    expect(extractUndefinedName('Unresolved import "utils"')).toBe("utils");
    expect(extractUndefinedName('unresolved reference "foo"')).toBe("foo");
  });

  it("无关文案返回 null", () => {
    expect(extractUndefinedName("IndentationError: unexpected indent")).toBeNull();
    expect(extractUndefinedName("E501 Line too long (120 > 100)")).toBeNull();
    expect(extractUndefinedName("")).toBeNull();
  });
});

describe("isSuppressedEngineAction（引擎动作抑制清单，PR-O 探针）", () => {
  it("pyrefly extract helper 变体被抑制（函数体漏 return，产出坏代码）", () => {
    expect(isSuppressedEngineAction("Extract into helper `extracted_function`")).toBe(true);
  });

  it("extract variable / introduce parameter / quickfix 类不受影响", () => {
    expect(isSuppressedEngineAction("Extract into variable `extracted_value`")).toBe(false);
    expect(isSuppressedEngineAction("Introduce parameter `param`")).toBe(false);
    expect(isSuppressedEngineAction("从 utils 导入 helper")).toBe(false);
    expect(isSuppressedEngineAction("")).toBe(false);
  });
});

describe("scanTopLevelSymbol（顶层定义轻量解析）", () => {
  const content = ["import os", "", "def helper(v):", "    return v", "", "class Widget:", "    pass", "", "COUNT = 3", ""].join("\n");

  it("识别 def / class / var 顶层定义", () => {
    expect(scanTopLevelSymbol(content, "helper")).toBe("def");
    expect(scanTopLevelSymbol(content, "Widget")).toBe("class");
    expect(scanTopLevelSymbol(content, "COUNT")).toBe("var");
  });

  it("缩进内定义不算顶层；变量类型注解（name: type =）也算", () => {
    const nested = ["def outer():", "    def helper():", "        pass", "    inner = 1", ""].join("\n");
    expect(scanTopLevelSymbol(nested, "helper")).toBeNull();
    expect(scanTopLevelSymbol("value: int = 5\n", "value")).toBe("var");
  });

  it("行尾注释不影响识别；未定义返回 null", () => {
    expect(scanTopLevelSymbol("COUNT = 3  # 总数\n", "COUNT")).toBe("var");
    expect(scanTopLevelSymbol("x = 1\n", "missing")).toBeNull();
  });
});

describe("findModuleHeaderEnd / findImportInsertLine（插入点定位）", () => {
  it("shebang + docstring 之后插入（无 import 区）", () => {
    const content = ["#!/usr/bin/env python3", '"""模块文档。', "", '多行。"""', "", "x = 1", ""].join("\n");
    expect(findModuleHeaderEnd(content)).toBe(4);
    expect(findImportInsertLine(content)).toBe(5); // 1 基：docstring 结束行的下一行
  });

  it("单行 docstring 同行闭合", () => {
    expect(findModuleHeaderEnd(['"""doc."""', "x = 1"].join("\n"))).toBe(1);
  });

  it("有 import 区时插到最后一条顶层 import 之后", () => {
    const content = ['"""doc."""', "", "import os", "", "import sys", "", "x = 1"].join("\n");
    expect(findImportInsertLine(content)).toBe(6); // 最后一条 import（第 5 行）的下一行
  });

  it("无 docstring 无 import：插在首行前导注释之后", () => {
    expect(findImportInsertLine(["# 说明", "x = 1"].join("\n"))).toBe(2);
    expect(findImportInsertLine("x = 1\n")).toBe(1);
  });
});

describe("inferCallArity（调用形态 → 实参个数）", () => {
  it("零参 / 多参 / 嵌套括号内的逗号不计", () => {
    expect(inferCallArity("helper()", "helper")).toBe(0);
    expect(inferCallArity("helper(a, b)", "helper")).toBe(2);
    expect(inferCallArity("helper(f(a, b), c)", "helper")).toBe(2);
    expect(inferCallArity("run('x,y', [1, 2], helper)", "run")).toBe(3);
  });

  it("*args / **kwargs / 未闭合括号 / 无调用 → null", () => {
    expect(inferCallArity("helper(*items)", "helper")).toBeNull();
    expect(inferCallArity("helper(a, **kw)", "helper")).toBeNull();
    expect(inferCallArity("helper(a, b", "helper")).toBeNull();
    expect(inferCallArity("x = 1", "helper")).toBeNull();
  });
});

describe("buildCreateStub（创建 stub 文案）", () => {
  it("函数按实参个数生成参数表", () => {
    expect(buildCreateStub("helper", "def", 2)).toContain("def helper(arg1, arg2):");
    expect(buildCreateStub("helper", "def", 0)).toContain("def helper():");
    expect(buildCreateStub("helper", "def", null)).toContain("def helper(*args, **kwargs):");
  });
  it("类 / 变量形态", () => {
    expect(buildCreateStub("Widget", "class", null)).toContain("class Widget:");
    expect(buildCreateStub("COUNT", "var", null)).toBe("COUNT = None  # TODO: 初始化");
  });
});

describe("buildNoqaLine（# noqa 行尾追加，D-4）", () => {
  it("追加 / 扩展 / 已存在 / 裸 noqa", () => {
    expect(buildNoqaLine("x = 1", "E501")).toBe("x = 1  # noqa: E501");
    expect(buildNoqaLine("x = 1  # noqa: F401", "E501")).toBe("x = 1  # noqa: F401,E501");
    expect(buildNoqaLine("x = 1  # noqa: E501", "E501")).toBeNull();
    expect(buildNoqaLine("x = 1  # noqa", "E501")).toBe("x = 1  # noqa"); // 裸 noqa 已忽略全部
  });
  it("去尾随空白后追加", () => {
    expect(buildNoqaLine("x = 1   ", "F401")).toBe("x = 1  # noqa: F401");
  });
});

describe("normalizeSeverity（D-4 严重度归一）", () => {
  it("合法值原样；非法/缺省回落 warning", () => {
    expect(normalizeSeverity("hint")).toBe("hint");
    expect(normalizeSeverity("ERROR")).toBe("error");
    expect(normalizeSeverity("info")).toBe("info");
    expect(normalizeSeverity("warning")).toBe("warning");
    expect(normalizeSeverity("bogus")).toBe("warning");
    expect(normalizeSeverity(undefined)).toBe("warning");
    expect(normalizeSeverity(null)).toBe("warning");
  });
});
