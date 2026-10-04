// F9（新建 FastAPI 项目）：projectTypeMeta 纯函数单测。
// 纯函数无 DOM 依赖（PROJECT_TYPES 为模块级常量表），node 环境直接 import。
import { describe, expect, it } from "vitest";
import { projectTypeMeta } from "../newProject";

describe("projectTypeMeta（F9 项目类型元数据）", () => {
  it("script：默认类型，label 正确、无依赖", () => {
    const m = projectTypeMeta("script");
    expect(m.type).toBe("script");
    expect(m.label).toBe("Python 脚本");
    expect(m.deps).toEqual([]);
  });

  it("fastapi：label 正确、deps 为 fastapi/uvicorn（安装 spec 与依赖声明共用源）", () => {
    const m = projectTypeMeta("fastapi");
    expect(m.type).toBe("fastapi");
    expect(m.label).toBe("FastAPI 服务");
    expect(m.deps).toEqual(["fastapi", "uvicorn"]);
  });

  it("未知值回退 script（与 Rust create_project 的回退口径一致）", () => {
    for (const bad of ["", "django", "flask", "FASTAPI", "fastapi ", "null", "unknown"]) {
      const m = projectTypeMeta(bad);
      expect(m.type, `type=${JSON.stringify(bad)} 应回退 script`).toBe("script");
      expect(m.deps, `type=${JSON.stringify(bad)} 回退后无依赖`).toEqual([]);
    }
  });

  it("返回的 deps 是副本（外部修改不污染元数据表）", () => {
    const m = projectTypeMeta("fastapi");
    m.deps.push("injected");
    expect(projectTypeMeta("fastapi").deps).toEqual(["fastapi", "uvicorn"]);
  });
});
