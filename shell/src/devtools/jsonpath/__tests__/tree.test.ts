import { describe, expect, it } from "vitest";
import { buildJsonTree, toJsonPath, toPythonSubscript, tryParseJson, type JsonNode } from "../tree";

const NUM = /^\d+$/;
/** 构造仅用于路径生成的轻量节点 */
function fake(segments: string[]): JsonNode {
  return {
    key: null,
    value: null,
    type: "null",
    segments,
    isIndex: NUM.test(segments[segments.length - 1] ?? ""),
    children: null,
  };
}

describe("tryParseJson", () => {
  it("解析合法 JSON", () => {
    const r = tryParseJson('{"a": 1}');
    expect(r.ok).toBe(true);
  });

  it("非法 JSON 返回错误", () => {
    const r = tryParseJson("{a: 1}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});

describe("buildJsonTree 结构", () => {
  it("构建对象 / 数组 / 标量节点并记录路径段", () => {
    const v = JSON.parse('{"data": {"items": [{"id": 1}]}}');
    const tree = buildJsonTree(v);
    expect(tree.type).toBe("object");
    const data = tree.children![0];
    expect(data.key).toBe("data");
    expect(data.segments).toEqual(["data"]);
    const items = data.children![0];
    expect(items.type).toBe("array");
    expect(items.segments).toEqual(["data", "items"]);
    const first = items.children![0];
    expect(first.isIndex).toBe(true);
    expect(first.segments).toEqual(["data", "items", "0"]);
    const id = first.children![0];
    expect(id.key).toBe("id");
    expect(id.value).toBe(1);
  });
});

describe("路径生成", () => {
  it("JSONPath：标识符键用点号，数组用下标", () => {
    expect(toJsonPath(fake(["data", "items", "0", "id"]))).toBe("$.data.items[0].id");
  });

  it("JSONPath：非标识符键用 [\"key\"]", () => {
    expect(toJsonPath(fake(["data", "a-b"]))).toBe('$.data["a-b"]');
  });

  it("Python 下标：一律用 [\"key\"] 与 [i]", () => {
    expect(toPythonSubscript(fake(["data", "items", "0", "id"]))).toBe('data["data"]["items"][0]["id"]');
    expect(toPythonSubscript(fake(["a b"]), "resp")).toBe('resp["a b"]');
  });

  it("根节点路径", () => {
    expect(toJsonPath(fake([]))).toBe("$");
    expect(toPythonSubscript(fake([]))).toBe("data");
  });
});