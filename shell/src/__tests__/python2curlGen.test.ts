// Python → cURL 反向生成（P1 · 库支持 §7-5）纯函数用例
import { describe, expect, it } from "vitest";
import { pythonToCurl } from "../devtools/builtin/python2curl.gen";

describe("pythonToCurl（requests/httpx 调用 → cURL）", () => {
  it("GET：仅 URL，省略 -X", () => {
    expect(pythonToCurl(`requests.get("https://api.example.com/users")`)).toBe(
      "curl 'https://api.example.com/users'",
    );
  });

  it("POST + json 实参：-X POST + Content-Type + -d JSON；headers 自定义", () => {
    const code = [
      'requests.post(',
      '    "https://api.example.com/login",',
      '    json={"user": "张三", "keep": True},',
      '    headers={"X-Token": "abc"},',
      ')',
    ].join("\n");
    const out = pythonToCurl(code);
    expect(out).toContain("-X POST 'https://api.example.com/login'");
    expect(out).toContain("-H 'X-Token: abc'");
    expect(out).toContain("-H 'Content-Type: application/json'");
    expect(out).toContain(`-d '{"user":"张三","keep":true}'`);
  });

  it("params 拼查询串（含已有 ?）；单引号 shell 转义", () => {
    const out = pythonToCurl(`requests.get("https://a.dev/search", params={"q": "it's", "page": 2})`);
    // encodeURIComponent 不转义 '，交由 shellQuote 的 '\'' 规则处理
    expect(out).toContain(`'https://a.dev/search?q=it'\\''s&page=2'`);
  });

  it("data dict → 多个 -d k=v；cookies → -b；timeout → --max-time；单引号字符串", () => {
    const code = `resp = httpx.post('https://a.dev/f', data={"a": 1, "b": "x"}, cookies={"sid": "1"}, timeout=5)`;
    const out = pythonToCurl(code);
    expect(out).toContain("-X POST 'https://a.dev/f'");
    expect(out).toContain("-d 'a=1'");
    expect(out).toContain("-d 'b=x'");
    expect(out).toContain("-b 'sid=1'");
    expect(out).toContain("--max-time 5");
  });

  it("非 raw 与 raw 字符串都支持；多个调用点逐个生成", () => {
    const code = [
      `r1 = requests.get(r"https://a.dev/raw")`,
      `r2 = requests.delete("https://a.dev/items/7")`,
    ].join("\n");
    const out = pythonToCurl(code);
    expect(out).toContain("curl 'https://a.dev/raw'");
    expect(out).toContain("-X DELETE 'https://a.dev/items/7'");
  });

  it("变量 / 表达式实参抛错（不臆测）；无调用点抛错", () => {
    expect(() => pythonToCurl(`requests.get(url)`)).toThrow(/非字面量/);
    expect(() => pythonToCurl(`requests.get(url, params={"a": 1})`)).toThrow(/非字面量/);
    expect(() => pythonToCurl(`print("hello")`)).toThrow(/未识别到/);
    expect(() => pythonToCurl(`req = requests.get("https://a.dev")`)).not.toThrow(); // 前缀变量不影响
  });

  it("对照：不误识别 requests.Session 等非动词调用", () => {
    expect(() => pythonToCurl(`s = requests.Session()`)).toThrow(/未识别到/);
  });
});
