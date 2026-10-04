// importAlias 纯函数测试（上下文解析 + 建议构建，无 Monaco 依赖）
import { describe, expect, it } from "vitest";
import {
  BUILTIN_IMPORT_ALIASES,
  importAliasItems,
  resolveImportAliasContext,
} from "../importAlias";

describe("resolveImportAliasContext 上下文解析", () => {
  it("import 模块名输入中（含空片段）→ module", () => {
    expect(resolveImportAliasContext("import pand")).toEqual({ kind: "module", typed: "pand" });
    expect(resolveImportAliasContext("import ")).toEqual({ kind: "module", typed: "" });
    expect(resolveImportAliasContext("import matplotlib.p")).toEqual({
      kind: "module",
      typed: "matplotlib.p",
    });
  });

  it("as 之后 → alias（片段可为空）", () => {
    expect(resolveImportAliasContext("import pandas as ")).toEqual({
      kind: "alias",
      path: "pandas",
      typed: "",
    });
    expect(resolveImportAliasContext("import pandas as p")).toEqual({
      kind: "alias",
      path: "pandas",
      typed: "p",
    });
    // 别名完整输入仍属 alias 上下文（弹窗确认选中，同 PyCharm）
    expect(resolveImportAliasContext("import pandas as pd")).toEqual({
      kind: "alias",
      path: "pandas",
      typed: "pd",
    });
  });

  it("前导空白不影响", () => {
    expect(resolveImportAliasContext("    import numpy")).toEqual({
      kind: "module",
      typed: "numpy",
    });
  });

  it("非 import 上下文一律 null（不污染普通补全）", () => {
    expect(resolveImportAliasContext("x = import")).toBeNull();
    expect(resolveImportAliasContext("from pandas import DataFrame")).toBeNull();
    expect(resolveImportAliasContext("df = pd.")).toBeNull();
    expect(resolveImportAliasContext("# import pan")).toBeNull();
    expect(resolveImportAliasContext("s = 'import pan")).toBeNull();
  });

  it("from-import as 之后 → fromAlias（认最后一个逗号段，容错圆括号）", () => {
    expect(resolveImportAliasContext("from pandas import DataFrame as ")).toEqual({
      kind: "fromAlias",
      module: "pandas",
      member: "DataFrame",
      typed: "",
    });
    expect(resolveImportAliasContext("from pandas import (DataFrame as DF")).toEqual({
      kind: "fromAlias",
      module: "pandas",
      member: "DataFrame",
      typed: "DF",
    });
    expect(
      resolveImportAliasContext("from collections import OrderedDict, defaultdict as "),
    ).toEqual({
      kind: "fromAlias",
      module: "collections",
      member: "defaultdict",
      typed: "",
    });
  });

  it("光标在词中间：前缀尾部决定上下文", () => {
    expect(resolveImportAliasContext("import pan")).toEqual({ kind: "module", typed: "pan" });
  });

  it("跨行：圆括号续行内的成员 as 补全（回溯前文未闭合 from-import）", () => {
    const prefix = "import os\n\nfrom pandas import (\n    DataFrame as ";
    expect(resolveImportAliasContext(prefix)).toEqual({
      kind: "fromAlias",
      module: "pandas",
      member: "DataFrame",
      typed: "",
    });
    // 跨行多成员：取当前行段（同口径「最后一个逗号段」语义）
    expect(
      resolveImportAliasContext("from collections import (\n    OrderedDict,\n    defaultdict as d"),
    ).toEqual({
      kind: "fromAlias",
      module: "collections",
      member: "defaultdict",
      typed: "d",
    });
    // 括号内空行/注释不打断续行
    expect(
      resolveImportAliasContext("from pandas import (\n    # 成员\n\n    DataFrame as "),
    ).toEqual({
      kind: "fromAlias",
      module: "pandas",
      member: "DataFrame",
      typed: "",
    });
  });

  it("跨行：续行闭合 / 无未闭合 from-import → null（不污染普通补全）", () => {
    // 闭括号收束后续行结束
    expect(
      resolveImportAliasContext("from pandas import (\n    DataFrame as DF)\nx = "),
    ).toBeNull();
    // 成员名单独成行（无 as）不产生上下文（成员名补全不归本 provider）
    expect(resolveImportAliasContext("from pandas import (\n    DataFra")).toBeNull();
    // 前文 from-import 已闭合（同行完结）
    expect(resolveImportAliasContext("from pandas import DataFrame\nx = ")).toBeNull();
  });
});

describe("importAliasItems 建议构建", () => {
  it("module 情形：按前缀过滤并生成 `path as alias` 变体", () => {
    const items = importAliasItems({ kind: "module", typed: "pan" });
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("pandas as pd");
    expect(items[0].insertText).toBe("pandas as pd");
    expect(items[0].filterText).toBe("pandas");
    expect(items[0].sortText).toBe("0z00"); // 三层契约 0xx 段 + 索引后缀
  });

  it("空片段列出全表；点分前缀命中子模块", () => {
    expect(importAliasItems({ kind: "module", typed: "" }).length).toBe(
      Object.keys(BUILTIN_IMPORT_ALIASES).length,
    );
    const plt = importAliasItems({ kind: "module", typed: "matplotlib.p" });
    expect(plt.map((i) => i.label)).toContain("matplotlib.pyplot as plt");
  });

  it("alias 情形：命中表内路径才给项；不匹配片段为空", () => {
    expect(importAliasItems({ kind: "alias", path: "pandas", typed: "" })).toEqual([
      expect.objectContaining({ label: "pd", insertText: "pd" }),
    ]);
    expect(importAliasItems({ kind: "alias", path: "pandas", typed: "p" })).toHaveLength(1);
    expect(importAliasItems({ kind: "alias", path: "pandas", typed: "x" })).toHaveLength(0);
    expect(importAliasItems({ kind: "alias", path: "os", typed: "" })).toHaveLength(0);
  });

  it("学习命中优先于内置表（module 变体次序 + alias 覆盖）", () => {
    const learned = [
      { kind: "module" as const, target: "pandas", alias: "p", count: 9 },
      { kind: "module" as const, target: "mymodels", alias: "mm", count: 3 },
    ];
    const items = importAliasItems({ kind: "module", typed: "" }, BUILTIN_IMPORT_ALIASES, learned);
    // 学习项在前且按 count 降序；内置 pandas 被去重不重复出现
    expect(items[0].label).toBe("pandas as p");
    expect(items[1].label).toBe("mymodels as mm");
    expect(items.filter((i) => i.filterText === "pandas")).toHaveLength(1);
    expect(items[0].sortText < items[1].sortText).toBe(true);
    // alias 情形：学习别名覆盖内置
    const alias = importAliasItems({ kind: "alias", path: "pandas", typed: "" }, undefined, learned);
    expect(alias[0].insertText).toBe("p");
  });

  it("fromAlias 情形：仅学习表提供成员别名", () => {
    const learned = [{ kind: "member" as const, target: "pandas.DataFrame", alias: "DF", count: 5 }];
    const items = importAliasItems(
      { kind: "fromAlias", module: "pandas", member: "DataFrame", typed: "" },
      BUILTIN_IMPORT_ALIASES,
      learned,
    );
    expect(items).toEqual([
      expect.objectContaining({ label: "DF", documentation: "from pandas import DataFrame as DF" }),
    ]);
    // 未学过 → 无建议
    expect(
      importAliasItems({ kind: "fromAlias", module: "os", member: "path", typed: "" }, BUILTIN_IMPORT_ALIASES, learned),
    ).toHaveLength(0);
  });
});
