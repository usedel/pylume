// PR-3：内置工具纯函数测试——标准向量（RFC 1321 MD5 / NIST SHA-256）+ 编解码往返 + 时间戳。

import { describe, expect, it } from "vitest";
import {
  base64Decode, base64Encode, md5Hex, nowUnixSeconds, sha256Hex, timestampToReadable, urlDecode, urlEncode, uuidV4,
} from "../pure";

describe("md5Hex（RFC 1321 标准向量）", () => {
  it("空串 → d41d8cd98f00b204e9800998ecf8427e", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });
  it("a → 0cc175b9c0f1b6a831c399e269772661", () => {
    expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
  });
  it("abc → 900150983cd24fb0d6963f7d28e17f72", () => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
  it("message digest → f96b697d7cb7938d525a2f31aaf161d0", () => {
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
  });
  it("长输入（跨多个 64 字节块）", () => {
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });
  it("UTF-8 中文", () => {
    expect(md5Hex("中文")).toBe("a7bac2239fcdcb3a067903d8077c4a07");
  });
});

describe("sha256Hex（NIST 标准向量）", () => {
  it("空串", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("abc", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("长输入", async () => {
    expect(await sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("Base64（UTF-8 安全）", () => {
  it("ASCII 往返", () => {
    expect(base64Encode("hello")).toBe("aGVsbG8=");
    expect(base64Decode("aGVsbG8=")).toBe("hello");
  });
  it("中文往返（UTF-8 多字节）", () => {
    const e = base64Encode("你好，Pylume！");
    expect(base64Decode(e)).toBe("你好，Pylume！");
  });
  it("emoji 往返（4 字节码点）", () => {
    const e = base64Encode("👍🐍");
    expect(base64Decode(e)).toBe("👍🐍");
  });
  it("非法 Base64 抛错", () => {
    expect(() => base64Decode("!!!not-base64!!!")).toThrow();
  });
});

describe("URL 编码", () => {
  it("保留字符与空格", () => {
    expect(urlEncode("a b&c=d")).toBe("a%20b%26c%3Dd");
    expect(urlDecode("a%20b%26c%3Dd")).toBe("a b&c=d");
  });
  it("+ 还原为空格（表单编码惯例）", () => {
    expect(urlDecode("a+b")).toBe("a b");
  });
  it("中文往返", () => {
    expect(urlDecode(urlEncode("搜索?q=中文"))).toBe("搜索?q=中文");
  });
});

describe("timestampToReadable", () => {
  it("10 位秒级", () => {
    // 2025-10-20 16:00:00 UTC+8 附近——只断言格式与非空，避免时区脆弱
    const r = timestampToReadable("1760985600");
    expect(r).not.toBeNull();
    expect(r).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 周[日一二三四五六]$/);
  });
  it("13 位毫秒级", () => {
    const r = timestampToReadable("1760985600000");
    expect(r).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 周[日一二三四五六]$/);
  });
  it("非法输入返回 null", () => {
    expect(timestampToReadable("abc")).toBeNull();
    expect(timestampToReadable("")).toBeNull();
    expect(timestampToReadable("123abc")).toBeNull();
  });
});

describe("nowUnixSeconds / uuidV4", () => {
  it("nowUnixSeconds 是 10 位数字字符串", () => {
    expect(nowUnixSeconds()).toMatch(/^\d{10}$/);
  });
  it("uuidV4 符合 v4 格式且不重复", () => {
    const a = uuidV4();
    const b = uuidV4();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
