import { describe, expect, it } from "vitest";
import { BUILTIN_ORDERING, BUILTIN_TEMPLATES } from "../builtin";

describe("内置模板库合理性", () => {
  it("async 三件套存在且可 Tab 展开（M4 补齐）", () => {
    for (const abbr of ["adef", "afor", "awith"]) {
      const t = BUILTIN_TEMPLATES.find((x) => x.abbreviation === abbr);
      expect(t, `缺少内置模板 ${abbr}`).toBeTruthy();
      expect(t?.tabExpand).toBe(true);
    }
  });

  it("main / ifmain / header 仅模块层 + 语句位（位置轴：起名/表达式位不触发）", () => {
    for (const abbr of ["main", "ifmain", "header"]) {
      const t = BUILTIN_TEMPLATES.find((x) => x.abbreviation === abbr);
      expect(t, `缺少内置模板 ${abbr}`).toBeTruthy();
      expect(t?.scopes).toEqual(["python:module"]);
      expect(t?.positions).toEqual(["statement"]);
    }
  });

  it("main 为函数定义，ifmain 为 __main__ 守卫（缩写分工）", () => {
    const fn = BUILTIN_TEMPLATES.find((t) => t.abbreviation === "main");
    const guard = BUILTIN_TEMPLATES.find((t) => t.abbreviation === "ifmain");
    expect(fn?.body).toContain("def main(");
    expect(guard?.body).toContain('if __name__ == "__main__"');
  });

  it("爬虫模板库（C 组）存在且为语句位、可 Tab 展开、覆盖 module/function、属 crawler 组", () => {
    const crawler = [
      "reqget", "reqpost", "reqsess", "hget",
      "bs4", "lxml", "css", "jsonld",
      "page", "ua", "proxy", "rsleep",
      "csvw", "jsonw",
    ];
    for (const abbr of crawler) {
      const t = BUILTIN_TEMPLATES.find((x) => x.abbreviation === abbr);
      expect(t, `缺少爬虫模板 ${abbr}`).toBeTruthy();
      expect(t?.kind, `${abbr} 应为 normal`).toBe("normal");
      expect(t?.tabExpand, `${abbr} 应可 Tab 展开`).toBe(true);
      expect(t?.positions, `${abbr} 应仅语句位`).toEqual(["statement"]);
      expect(t?.scopes, `${abbr} 应覆盖 module`).toContain("python:module");
      expect(t?.scopes, `${abbr} 应覆盖 function`).toContain("python:function");
      expect(t?.group, `${abbr} 应属「爬虫」组`).toBe("爬虫");
    }
  });

  it("分组区分：仅爬虫插入模板带 group=crawler，其余内置模板不带该组", () => {
    const crawlerAbbrs = new Set([
      "reqget", "reqpost", "reqsess", "hget",
      "bs4", "lxml", "css", "jsonld",
      "page", "ua", "proxy", "rsleep",
      "csvw", "jsonw",
    ]);
    for (const t of BUILTIN_TEMPLATES) {
      const isCrawler = t.kind === "normal" && crawlerAbbrs.has(t.abbreviation);
      if (isCrawler) {
        expect(t.group, `${t.abbreviation} 应属「爬虫」组`).toBe("爬虫");
      } else {
        expect(t.group, `${t.abbreviation} 不应属「爬虫」组`).not.toBe("爬虫");
      }
    }
  });

  it("同一 (scope, kind) 内缩写唯一（M3：同缩写可跨范式共存）", () => {
    const seen = new Map<string, string>();
    for (const t of BUILTIN_TEMPLATES) {
      for (const scope of t.scopes) {
        const key = `${scope}\u0000${t.kind}\u0000${t.abbreviation}`;
        expect(seen.has(key), `${scope}/${t.kind} 内缩写 ${t.abbreviation} 重复`).toBe(false);
        seen.set(key, t.id);
      }
    }
  });

  it("ordering 引用的缩写在对应 scope 内存在（仅插入模板参与排序）", () => {
    for (const [scope, abbrs] of Object.entries(BUILTIN_ORDERING)) {
      const available = new Set(
        BUILTIN_TEMPLATES.filter((t) => t.kind === "normal" && t.scopes.includes(scope)).map(
          (t) => t.abbreviation,
        ),
      );
      for (const a of abbrs) {
        expect(available.has(a), `${scope} 排序引用了不存在的缩写 ${a}`).toBe(true);
      }
    }
  });

  it("环绕模板必须含 $SELECTION$；后缀模板必须有后缀键（M3 范式约束）", () => {
    const surrounds = BUILTIN_TEMPLATES.filter((t) => t.kind === "surround");
    const postfixes = BUILTIN_TEMPLATES.filter((t) => t.kind === "postfix");
    expect(surrounds.length).toBeGreaterThanOrEqual(4);
    expect(postfixes.length).toBeGreaterThanOrEqual(10);
    for (const t of surrounds) {
      expect(t.body, `${t.id} 缺少 $SELECTION$`).toContain("$SELECTION$");
    }
    for (const t of postfixes) {
      expect(t.postfixKey, `${t.id} 缺少 postfixKey`).toBeTruthy();
      expect(t.body, `${t.id} 缺少 $EXPR$`).toContain("$EXPR$");
    }
  });
});
