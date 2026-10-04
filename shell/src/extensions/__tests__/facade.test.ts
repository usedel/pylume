// @vitest-environment happy-dom
// PR-2：权限门控 facade 测试（plugin_system_design §9.4）。
// 覆盖：未声明权限抛 PermissionDeniedError；已声明放行；storage 命名空间隔离与清理；
// monaco 显式授予（决策点 #13）；InlineHost 无 root/kit（决策点 #12）。

import { describe, expect, it } from "vitest";
import { clearPluginStorage, createInlineHost, createPanelHost, PermissionDeniedError, type FacadeDeps } from "../facade";
import { validateManifest } from "../manifest";

const MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: "com.test.demo",
  name: "Demo",
  version: "1.0.0",
  engines: { pylume: ">=0.1.0" },
  contributes: {
    tools: [{ id: "t1", title: "T1", entry: "./t.js", inline: { label: "变换", handler: "h" } }],
  },
  permissions: ["clipboard", "storage"],
});

function manifestWith(perms: string[]) {
  const m = JSON.parse(MANIFEST_JSON);
  m.permissions = perms;
  return validateManifest(JSON.stringify(m)).manifest!;
}

const deps: FacadeDeps = {
  monaco: {} as never,
  workspaceRoot: () => "/ws",
  getSelectedText: () => "selected",
  replaceSelection: () => true,
  insertToEditor: () => true,
};

describe("权限门控", () => {
  it("未声明 clipboard → readClipboard 抛 PermissionDeniedError", () => {
    const host = createInlineHost(manifestWith([]), "/dir", deps);
    expect(() => host.readClipboard()).toThrow(PermissionDeniedError);
  });

  it("已声明 clipboard → 不抛（读失败返回 null 不影响门控语义）", () => {
    const host = createInlineHost(manifestWith(["clipboard"]), "/dir", deps);
    // Tauri invoke 在测试环境不存在 → readClipboard 内部 catch 返回 null；门控已放行
    expect(() => host.readClipboard()).not.toThrow();
  });

  it("未声明 selection → getSelectedText 抛（已声明则放行）", () => {
    const no = createInlineHost(manifestWith([]), "/dir", deps);
    expect(() => no.getSelectedText()).toThrow(PermissionDeniedError);
    const yes = createInlineHost(manifestWith(["selection"]), "/dir", deps);
    expect(yes.getSelectedText()).toBe("selected");
  });

  it("storage 未声明拒绝；已声明走插件命名空间", () => {
    const no = createInlineHost(manifestWith([]), "/dir", deps);
    expect(() => no.storage.get("k")).toThrow(PermissionDeniedError);

    const yes = createInlineHost(manifestWith(["storage"]), "/dir", deps);
    yes.storage.set("k", "v");
    expect(yes.storage.get("k")).toBe("v");
    expect(localStorage.getItem("pylume.plugin.com.test.demo.k")).toBe("v"); // 命名空间隔离
    yes.storage.clear();
    expect(localStorage.getItem("pylume.plugin.com.test.demo.k")).toBeNull();
  });

  it("fs:read 未声明 → workspaceRoot / readFile 拒绝", () => {
    const host = createInlineHost(manifestWith([]), "/dir", deps);
    expect(() => host.workspaceRoot()).toThrow(PermissionDeniedError);
    expect(() => void host.readFile("a.js")).toThrow(PermissionDeniedError);
  });
});

describe("PanelHost / InlineHost 分型", () => {
  it("PanelHost 有 root/kit；未声明 monaco 则无", () => {
    const root = document.createElement("div");
    const host = createPanelHost(manifestWith([]), "/dir", root, deps);
    expect(host.root).toBe(root);
    expect(host.kit).toBeTruthy();
    expect(host.monaco).toBeUndefined();
  });

  it("声明 monaco → 显式授予", () => {
    const root = document.createElement("div");
    const host = createPanelHost(manifestWith(["monaco"]), "/dir", root, deps);
    expect(host.monaco).toBeDefined();
  });
});

describe("clearPluginStorage", () => {
  it("只清目标插件前缀，不动其他", () => {
    localStorage.setItem("pylume.plugin.com.test.demo.a", "1");
    localStorage.setItem("pylume.plugin.com.other.b", "2");
    localStorage.setItem("unrelated", "3");
    clearPluginStorage("com.test.demo");
    expect(localStorage.getItem("pylume.plugin.com.test.demo.a")).toBeNull();
    expect(localStorage.getItem("pylume.plugin.com.other.b")).toBe("2");
    expect(localStorage.getItem("unrelated")).toBe("3");
    localStorage.clear();
  });
});
