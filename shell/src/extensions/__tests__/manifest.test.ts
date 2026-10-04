// PR-2：manifest 校验器测试（plugin_system_design §9.2）。
// 纯函数：合法/非法 JSON、schemaVersion、id、engines 形式、权限、工具声明、engines 兼容比较。

import { describe, expect, it } from "vitest";
import { checkEnginesCompatible, pluginToolId, validateManifest } from "../manifest";

const VALID = JSON.stringify({
  schemaVersion: 1,
  id: "com.example.my-tools",
  name: "My Tools",
  version: "1.0.0",
  engines: { pylume: ">=0.5.0" },
  contributes: {
    tools: [
      {
        id: "jwt-decoder",
        title: "JWT 解码",
        description: "解码 JWT",
        category: "编码",
        icon: "key",
        entry: "./tools/jwt.js",
        inline: { label: "解码 JWT 选区", handler: "decodeSelection" },
      },
    ],
  },
  permissions: ["clipboard", "selection"],
});

describe("validateManifest", () => {
  it("合法 manifest 通过并解析全部字段", () => {
    const r = validateManifest(VALID);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.manifest?.id).toBe("com.example.my-tools");
    expect(r.manifest?.permissions).toEqual(["clipboard", "selection"]);
    const tool = r.manifest?.contributes?.tools?.[0];
    expect(tool?.id).toBe("jwt-decoder");
    expect(tool?.inline?.handler).toBe("decodeSelection");
  });

  it("非法 JSON 返回单条错误", () => {
    const r = validateManifest("{oops");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.key).toBe("ext.mf.invalidJson");
  });

  it("根非对象拒绝", () => {
    expect(validateManifest("[1,2]").ok).toBe(false);
    expect(validateManifest("null").ok).toBe(false);
  });

  it("schemaVersion 非 1 拒绝", () => {
    const bad = JSON.parse(VALID);
    bad.schemaVersion = 2;
    const r = validateManifest(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.key).join()).toContain("ext.mf.schemaVersion");
  });

  it("id 非法（空白/路径分隔符）拒绝", () => {
    for (const id of ["", "a b", "../evil", "中文"]) {
      const bad = JSON.parse(VALID);
      bad.id = id;
      const r = validateManifest(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.key).join()).toContain("ext.mf.badId");
    }
  });

  it("engines 仅支持 >=X.Y.Z 形式", () => {
    for (const spec of ["^1.0.0", "0.5.0", ">0.5", ">=1.0"]) {
      const bad = JSON.parse(VALID);
      bad.engines = { pylume: spec };
      const r = validateManifest(JSON.stringify(bad));
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.key).join()).toContain("ext.mf.engines");
    }
  });

  it("未知权限拒绝（防拼错静默失效）", () => {
    const bad = JSON.parse(VALID);
    bad.permissions = ["clipbord"];
    const r = validateManifest(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.key).join()).toContain("ext.mf.unknownPerm");
  });

  it("权限去重后通过", () => {
    const good = JSON.parse(VALID);
    good.permissions = ["clipboard", "clipboard"];
    const r = validateManifest(JSON.stringify(good));
    expect(r.ok).toBe(true);
    expect(r.manifest?.permissions).toEqual(["clipboard"]);
  });

  it("contributes.tools 缺失或为空拒绝", () => {
    const bad = JSON.parse(VALID);
    bad.contributes = { tools: [] };
    expect(validateManifest(JSON.stringify(bad)).ok).toBe(false);
    const bad2 = JSON.parse(VALID);
    delete bad2.contributes;
    expect(validateManifest(JSON.stringify(bad2)).ok).toBe(false);
  });

  it("工具缺 entry / title / id 被过滤且整体失败", () => {
    const bad = JSON.parse(VALID);
    bad.contributes.tools = [{ id: "x" }];
    const r = validateManifest(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });
});

describe("checkEnginesCompatible", () => {
  it("版本满足下限", () => {
    expect(checkEnginesCompatible(">=0.5.0", "0.5.0")).toBe(true);
    expect(checkEnginesCompatible(">=0.5.0", "1.2.3")).toBe(true);
    expect(checkEnginesCompatible(">=0.5.0", "0.10.0")).toBe(true);
  });

  it("版本不满足下限", () => {
    expect(checkEnginesCompatible(">=0.5.0", "0.4.9")).toBe(false);
    expect(checkEnginesCompatible(">=1.0.0", "0.9.9")).toBe(false);
  });

  it("非 >=X.Y.Z 形式一律不兼容（校验层已挡，双保险）", () => {
    expect(checkEnginesCompatible("^1.0.0", "1.0.0")).toBe(false);
  });
});

describe("pluginToolId", () => {
  it("全局键 = 插件 id + 工具 id", () => {
    expect(pluginToolId("com.example.t", "jwt")).toBe("com.example.t.jwt");
  });
});
