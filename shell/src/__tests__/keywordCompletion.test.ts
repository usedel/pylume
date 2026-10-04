import { beforeEach, describe, expect, it } from "vitest";
import { KEYWORDS, KEYWORD_LANGUAGES } from "../completion/keywords.gen";
import { keywordItems, registerKeywordCompletion, setKeywordCompletionEnabled } from "../completion/keywordCompletion";
import { languageOf } from "../util";

const RANGE = { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 4 };

/** provider 回调的最小结构（不 import Monaco，避免把真编辑器拖进单测） */
interface FakeProvider {
  provideCompletionItems(
    model: {
      getLanguageId(): string;
      getWordUntilPosition(p: { lineNumber: number; column: number }): { startColumn: number; endColumn: number };
    },
    position: { lineNumber: number; column: number },
  ): { suggestions: Array<Record<string, unknown>> };
}

/** 捕获注册进 Monaco 桩的 provider（selector 一并留下验语言集合） */
function captureRegistration() {
  let captured: { selector: readonly string[]; provider: unknown } | null = null;
  const stub = {
    languages: {
      CompletionItemKind: { Keyword: 17 },
      registerCompletionItemProvider: (selector: readonly string[], provider: unknown) => {
        captured = { selector, provider };
        return { dispose: () => undefined };
      },
    },
  };
  registerKeywordCompletion(stub as unknown as Parameters<typeof registerKeywordCompletion>[0]);
  if (!captured) throw new Error("provider 未被注册");
  return captured as { selector: readonly string[]; provider: FakeProvider };
}

function fakeModel(languageId: string, word = "") {
  return {
    getLanguageId: () => languageId,
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 + word.length }),
  };
}

describe("keywordItems（零引擎关键字补全 · 纯函数）", () => {
  it("python 不产出关键字——避免与模板 0xx / intel 1xx / 静态引擎 2xx 三段重复", () => {
    expect(keywordItems("python", RANGE)).toEqual([]);
    expect(KEYWORD_LANGUAGES).not.toContain("python");
    expect(KEYWORDS.python).toBeUndefined();
  });

  it("未提取到关键字的语言返回空数组（不注册即不触发，双保险）", () => {
    expect(keywordItems("plaintext", RANGE)).toEqual([]);
    expect(keywordItems("markdown", RANGE)).toEqual([]);
    expect(keywordItems("css", RANGE)).toEqual([]);
    expect(keywordItems("dockerfile", RANGE)).toEqual([]);
  });

  it("已覆盖语言产出关键字，且字段完整", () => {
    const items = keywordItems("typescript", RANGE);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("interface");
    expect(labels).toContain("readonly");
    for (const it of items) {
      expect(it.insertText).toBe(it.label);
      expect(it.detail).toBe("关键字");
      expect(it.range).toEqual(RANGE); // 替换范围原样透传（调用方给的是 wordUntilPosition）
    }
  });

  it("sql 关键字保持大写（SQL 惯例，插入即大写）", () => {
    const items = keywordItems("sql", RANGE);
    expect(items.map((i) => i.label)).toContain("SELECT");
    expect(items.every((i) => i.label === i.label.toUpperCase())).toBe(true);
  });

  it("sortText 恒在最低优先级 3xx 段：唯一、格式固定、字典序排在 2xx 之后", () => {
    // Monaco 对 sortText 走 localeCompare；此处断言与 client.ts 静态引擎段（"2"+3 位）的先后关系
    expect("3000".localeCompare("2999")).toBe(1);
    for (const lang of KEYWORD_LANGUAGES) {
      const items = keywordItems(lang, RANGE);
      expect(items.length).toBeGreaterThan(0);
      const sorts = items.map((i) => i.sortText);
      expect(new Set(sorts).size).toBe(sorts.length); // 段内唯一 ⇒ 排序稳定
      for (const s of sorts) {
        expect(s).toMatch(/^3\d{3}$/);
      }
    }
  });
});

describe("keywords.gen 生成物不变量", () => {
  it("语言集合锁定为已确认白名单（变更需同步改此断言）", () => {
    expect([...KEYWORD_LANGUAGES].sort()).toEqual([
      "bat",
      "javascript",
      "json",
      "powershell",
      "rust",
      "shell",
      "sql",
      "typescript",
      "yaml",
    ]);
  });

  it("每种语言的关键字非空、无重复、无空白、均为合法标识符", () => {
    for (const [lang, words] of Object.entries(KEYWORDS)) {
      expect(words.length, `${lang} 关键字不应为空`).toBeGreaterThan(0);
      expect(new Set(words).size, `${lang} 存在重复关键字`).toBe(words.length);
      for (const w of words) {
        expect(w, `${lang} 关键字含首尾空白`).toBe(w.trim());
        expect(w, `${lang} 关键字 ${w} 不是合法标识符`).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/);
      }
    }
  });

  it("每种语言都能被 languageOf 从真实扩展名解析出来（否则 provider 永不触发）", () => {
    const samples: Record<string, string> = {
      bat: "run.bat",
      javascript: "app.js",
      json: "data.json",
      powershell: "deploy.ps1",
      rust: "lib.rs",
      shell: "build.sh",
      sql: "query.sql",
      typescript: "index.ts",
      yaml: "ci.yml",
    };
    for (const lang of KEYWORD_LANGUAGES) {
      expect(languageOf(samples[lang]), `${lang} 缺少扩展名映射`).toBe(lang);
    }
  });
});

describe("provider 接线（语言门控 / 开关 / 段位 / range）", () => {
  beforeEach(() => setKeywordCompletionEnabled(true));

  it("注册的语言集合 = KEYWORD_LANGUAGES，且不含 python", () => {
    const { selector } = captureRegistration();
    expect([...selector].sort()).toEqual([...KEYWORD_LANGUAGES].sort());
    expect(selector).not.toContain("python");
  });

  it("python 模型返回空（双保险：数据里也没有 python）", () => {
    const { provider } = captureRegistration();
    const res = provider.provideCompletionItems(fakeModel("python"), { lineNumber: 1, column: 1 });
    expect(res.suggestions).toEqual([]);
  });

  it("json 模型返回关键字项：kind=Keyword、sortText 落 3xx、range 随词边界", () => {
    const { provider } = captureRegistration();
    const res = provider.provideCompletionItems(fakeModel("json", "tr"), { lineNumber: 3, column: 3 });
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(res.suggestions.some((s) => s.label === "true")).toBe(true);
    for (const s of res.suggestions) {
      expect(s.kind).toBe(17); // CompletionItemKind.Keyword
      expect(s.sortText).toMatch(/^3\d{3}$/);
      expect(s.range).toEqual({ startLineNumber: 3, endLineNumber: 3, startColumn: 1, endColumn: 3 });
    }
  });

  it("开关关闭后同一模型返回空，重新开启即恢复（provider 不重注册）", () => {
    const { provider } = captureRegistration();
    const model = fakeModel("json");
    const at = { lineNumber: 1, column: 1 };
    expect(provider.provideCompletionItems(model, at).suggestions.length).toBeGreaterThan(0);
    setKeywordCompletionEnabled(false);
    expect(provider.provideCompletionItems(model, at).suggestions).toEqual([]);
    setKeywordCompletionEnabled(true);
    expect(provider.provideCompletionItems(model, at).suggestions.length).toBeGreaterThan(0);
  });
});
