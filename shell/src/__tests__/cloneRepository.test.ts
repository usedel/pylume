import { describe, it, expect } from "vitest";
import { detectPlatform, deriveTargetDir } from "../cloneRepository";

describe("detectPlatform", () => {
  it("识别 https GitHub", () => {
    expect(detectPlatform("https://github.com/user/repo.git")).toBe("github");
  });
  it("识别 https GitLab", () => {
    expect(detectPlatform("https://gitlab.com/user/repo")).toBe("gitlab");
  });
  it("识别 https Gitee", () => {
    expect(detectPlatform("https://gitee.com/user/repo.git")).toBe("gitee");
  });
  it("识别 ssh git@github.com", () => {
    expect(detectPlatform("git@github.com:user/repo.git")).toBe("github");
  });
  it("识别 file://", () => {
    expect(detectPlatform("file:///path/to/repo")).toBe("other");
  });
  it("空字符串返回 other", () => {
    expect(detectPlatform("")).toBe("other");
  });
  it("无 scheme 返回 other", () => {
    expect(detectPlatform("example.com/repo")).toBe("other");
  });
});

describe("deriveTargetDir", () => {
  it("从 https URL 推导目录名", () => {
    expect(deriveTargetDir("https://github.com/user/repo.git", "/work")).toBe("/work/repo");
  });
  it("从 ssh URL 推导目录名", () => {
    expect(deriveTargetDir("git@github.com:user/my-app.git", "/work")).toBe("/work/my-app");
  });
  it("无 .git 后缀保留原样", () => {
    expect(deriveTargetDir("https://github.com/user/repo", "/work")).toBe("/work/repo");
  });
  it("无 scheme 回退到最后一段", () => {
    expect(deriveTargetDir("some/path/repo", "/work")).toBe("/work/repo");
  });
});
