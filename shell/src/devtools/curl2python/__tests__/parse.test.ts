import { describe, expect, it } from "vitest";
import { generatePython } from "../gen";
import { parseCurl, tokenizeShell } from "../parse";

describe("tokenizeShell 词法", () => {
  it("按空白分割，保留引号内空格", () => {
    expect(tokenizeShell("curl 'https://a.com/x y' -H 'a: b'")).toEqual([
      "curl",
      "https://a.com/x y",
      "-H",
      "a: b",
    ]);
  });

  it("双引号内转义引号", () => {
    expect(tokenizeShell('"a\\"b" c')).toEqual(['a"b', "c"]);
  });
});

describe("parseCurl 解析", () => {
  it("识别 GET + headers", () => {
    const cmd = parseCurl("curl 'https://example.com/api' -H 'User-Agent: Mozilla/5.0' -H 'Accept: application/json'");
    expect(cmd.method).toBe("GET");
    expect(cmd.url).toBe("https://example.com/api");
    expect(cmd.headers).toEqual([
      ["User-Agent", "Mozilla/5.0"],
      ["Accept", "application/json"],
    ]);
  });

  it("识别 POST JSON body（--data-raw + Content-Type 推导）", () => {
    const cmd = parseCurl(
      "curl -X POST 'https://example.com/api' -H 'Content-Type: application/json' --data-raw '{\"a\":1}'",
    );
    expect(cmd.method).toBe("POST");
    expect(cmd.data).toBe('{"a":1}');
    expect(cmd.dataAsJson).toBe(true);
  });

  it("识别 -u / -k / -G 等布尔与取值 flag", () => {
    const cmd = parseCurl("curl -k -u 'user:pass' -G 'https://a.com' -d 'q=1&x=2'");
    expect(cmd.insecure).toBe(true);
    expect(cmd.user).toBe("user:pass");
    expect(cmd.useGetQuery).toBe(true);
    expect(cmd.data).toBe("q=1&x=2");
    expect(cmd.method).toBe("GET");
  });

  it("识别 -F form 与 --url", () => {
    const cmd = parseCurl("curl -F 'name=Alice' -F 'file=@/tmp/a.txt' --url https://example.com/upload");
    expect(cmd.url).toBe("https://example.com/upload");
    expect(cmd.form).toEqual([
      ["name", "Alice"],
      ["file", "@/tmp/a.txt"],
    ]);
    expect(cmd.method).toBe("POST");
  });
});

describe("generatePython 生成", () => {
  it("生成 requests.post + json", () => {
    const cmd = parseCurl(
      "curl -X POST 'https://example.com/api' -H 'Content-Type: application/json' --data-raw '{\"a\":1}'",
    );
    const code = generatePython(cmd);
    expect(code).toContain("import requests");
    expect(code).toContain("requests.post(");
    expect(code).toContain('"https://example.com/api"');
    expect(code).toContain('"a": 1');
    expect(code).toContain("resp.raise_for_status()");
  });

  it("生成 auth / verify=False / cookie", () => {
    const cmd = parseCurl("curl -k -u 'user:pass' -b 'sid=abc' 'https://a.com'");
    const code = generatePython(cmd);
    expect(code).toContain("auth=(\"user\", \"pass\")");
    expect(code).toContain("verify=False");
    expect(code).toContain('"sid": "abc"');
  });
});