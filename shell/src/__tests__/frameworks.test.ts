import { describe, expect, it } from "vitest";
import {
  frameworkHintText,
  frameworkLabel,
  fullEndpointUrl,
  joinRoute,
  presetConfigured,
  type FrameworkPreset,
} from "../frameworks";

/** 构造预设（只填测试关心的字段） */
function preset(p: Partial<FrameworkPreset> & { framework: FrameworkPreset["framework"] }): FrameworkPreset {
  return {
    label: p.framework === "fastapi" ? "FastAPI" : p.framework === "django" ? "Django" : "Flask",
    file: "main.py",
    entry: { kind: "module", target: "uvicorn" },
    args: "",
    cwd: "${workspaceRoot}",
    summary: "",
    missing: [],
    ...p,
  };
}

describe("frameworks（框架探针表 TS 侧）", () => {
  it("frameworkLabel：后端 label 缺失时按 kind 回退", () => {
    expect(frameworkLabel(preset({ framework: "flask", label: "Flask" }))).toBe("Flask");
    expect(frameworkLabel(preset({ framework: "django", label: "" }))).toBe("django");
  });

  it("frameworkHintText：缺失依赖单独成句并提示可安装", () => {
    const withMiss = preset({ framework: "fastapi", file: "main.py", missing: ["uvicorn"] });
    expect(frameworkHintText(withMiss)).toBe(
      "检测到 FastAPI 项目（main.py）。尚未安装 uvicorn（可 uv add uvicorn）。可一键生成运行配置：",
    );
    const noMiss = preset({ framework: "django", file: "manage.py" });
    expect(frameworkHintText(noMiss)).toBe("检测到 Django 项目（manage.py）。可一键生成运行配置：");
    // 多个缺失用「、」连接
    expect(frameworkHintText(preset({ framework: "flask", missing: ["flask", "dotenv"] }))).toContain(
      "尚未安装 flask、dotenv",
    );
  });

  it("presetConfigured：入口 kind+target 全等才算已配置（target 大小写不敏感）", () => {
    const fastapi = preset({ framework: "fastapi", entry: { kind: "module", target: "uvicorn" } });
    expect(presetConfigured(null, fastapi)).toBe(false);
    expect(presetConfigured(undefined, fastapi)).toBe(false);
    expect(presetConfigured({ entry: { kind: "module", target: "Uvicorn" } }, fastapi)).toBe(true);
    expect(presetConfigured({ entry: { kind: "module", target: "flask" } }, fastapi)).toBe(false);
    // kind 不同（script vs module）不算已配置
    expect(presetConfigured({ entry: { kind: "script", target: "uvicorn" } }, fastapi)).toBe(false);
  });

  it("presetConfigured：Django 预设按 script 入口判定", () => {
    const django = preset({
      framework: "django",
      file: "manage.py",
      entry: { kind: "script", target: "manage.py" },
      args: "runserver",
    });
    expect(presetConfigured({ entry: { kind: "script", target: "manage.py" } }, django)).toBe(true);
    expect(presetConfigured({ entry: { kind: "script", target: "main.py" } }, django)).toBe(false);
  });

  it("joinRoute：斜杠归一 + 空段跳过 + 全空根路径（F1）", () => {
    expect(joinRoute("/v1", "/api", "/users/{uid}")).toBe("/v1/api/users/{uid}");
    expect(joinRoute("", "/x")).toBe("/x");
    expect(joinRoute("", "")).toBe("/");
    expect(joinRoute("v1/", "//users/")).toBe("/v1/users");
    // 路径参数原样保留（FastAPI {id} / Flask <int:id>）
    expect(joinRoute("/api", "/items/<int:id>")).toBe("/api/items/<int:id>");
  });

  it("fullEndpointUrl：无 base 返回 null，base 尾斜杠归一（F2）", () => {
    expect(fullEndpointUrl(null, "/x")).toBeNull();
    expect(fullEndpointUrl("http://127.0.0.1:8000", "/api/x")).toBe("http://127.0.0.1:8000/api/x");
    expect(fullEndpointUrl("http://127.0.0.1:8000/", "/api/x")).toBe("http://127.0.0.1:8000/api/x");
  });
});
