import { describe, expect, it } from "vitest";
import { KEYWORD_LANGUAGES } from "../completion/keywords.gen";
import { wordBasedSuggestionsFor } from "../completion/wordBasedSuggestions";

describe("wordBasedSuggestionsFor（文档词补全按语言取值）", () => {
  it("python 恒 off——词建议会淹没 pyfly/intel 的语义补全（踩坑 #3）", () => {
    expect(wordBasedSuggestionsFor("python")).toBe("off");
  });

  it("无引擎语言取当前文档的词（保守档，不跨文件同步 model）", () => {
    for (const lang of ["json", "jsonc", "yaml", "ini", "sql", "rust", "shell", "bat", "powershell", "typescript"]) {
      expect(wordBasedSuggestionsFor(lang), `${lang} 应开启词补全`).toBe("currentDocument");
    }
  });

  it("无 model（null / undefined）与未登记语言取非引擎档", () => {
    expect(wordBasedSuggestionsFor(null)).toBe("currentDocument");
    expect(wordBasedSuggestionsFor(undefined)).toBe("currentDocument");
    expect(wordBasedSuggestionsFor("")).toBe("currentDocument");
    expect(wordBasedSuggestionsFor("plaintext")).toBe("currentDocument");
  });

  it("语言 ID 必须小写——Monaco 的 getLanguageId() 即注册 id（本映射与关键字表都按此契约）", () => {
    // 记录假设：若哪天出现大写语言 ID，这里会先红，提示需要归一化后再查表
    expect(wordBasedSuggestionsFor("Python")).toBe("currentDocument");
  });

  it("关键字补全语言与「被抑制语言」无交集：两份名单不得互相打架", () => {
    // 若将来给某语言接了真引擎，必须同时把它移出 KEYWORD_LANGUAGES（否则关键字 + 词补全 + 引擎三份并存）
    expect(KEYWORD_LANGUAGES.filter((l) => wordBasedSuggestionsFor(l) === "off")).toEqual([]);
  });
});
