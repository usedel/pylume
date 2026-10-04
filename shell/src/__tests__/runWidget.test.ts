// @vitest-environment happy-dom
// v3.4 §7.3 状态 × 界面矩阵（M3-3.4 四控件运行组）：computeRunWidget 的纯函数单测。
import { describe, expect, it } from "vitest";
import { computeRunWidget, type RunWidgetState } from "../runWidget";
import { t } from "../i18n"; // 断言走 t(key)：默认中文等价于原文断言，切默认语言也不用改

function s(partial: Partial<RunWidgetState>): RunWidgetState {
  return {
    hasWs: true,
    canRunScript: true,
    scriptDisabledReason: "",
    canRunProject: true,
    projectDisabledReason: "",
    scriptBusy: false,
    projectBusy: false,
    scriptPreparing: false,
    projectPreparing: false,
    debugging: false,
    runScriptShortcut: "Ctrl+F10",
    runProjectShortcut: "Ctrl+Shift+F10",
    stopShortcut: "Ctrl+F2",
    stopTarget: null,
    canOpenConfig: true,
    ...partial,
  };
}

describe("computeRunWidget 四控件（§7.3 矩阵）", () => {
  it("idle：▶ 脚本/项目可用带快捷键，⏹ 置灰，⚙ 可用", () => {
    const c = computeRunWidget(s({}));
    expect(c.runScript.disabled).toBe(false);
    expect(c.runScript.tipKey).toBe("Ctrl+F10");
    expect(c.runProject.disabled).toBe(false);
    expect(c.runProject.tipKey).toBe("Ctrl+Shift+F10");
    expect(c.stop.disabled).toBe(true);
    expect(c.stop.tip).toBe(t("run.widget.notRunning"));
    expect(c.config.disabled).toBe(false);
  });

  it("无工作区（§18 裁决 7：含脚本运行一律禁用）：四控件全置灰 + 原因", () => {
    const c = computeRunWidget(s({
      hasWs: false,
      canRunScript: false,
      scriptDisabledReason: "未打开工作区",
      canRunProject: false,
      projectDisabledReason: "未打开工作区",
      canOpenConfig: false,
    }));
    expect(c.runScript.disabled).toBe(true);
    expect(c.runScript.tip).toBe(t("run.flow.noWorkspace"));
    expect(c.runProject.disabled).toBe(true);
    expect(c.runProject.tip).toBe(t("run.flow.noWorkspace"));
    expect(c.config.disabled).toBe(true);
  });

  it("非 .py 文件：仅「运行脚本」置灰并带原因，项目运行不受影响", () => {
    const c = computeRunWidget(s({ canRunScript: false, scriptDisabledReason: "当前文件不是 Python 文件" }));
    expect(c.runScript.disabled).toBe(true);
    expect(c.runScript.tip).toBe(t("run.flow.notPyFile"));
    expect(c.runProject.disabled).toBe(false);
  });

  it("preparing（脚本）：▶ 脚本 spinner + 专属提示，项目不受影响", () => {
    const c = computeRunWidget(s({ scriptPreparing: true }));
    expect(c.runScript.disabled).toBe(true);
    expect(c.runScript.busy).toBe(true);
    expect(c.runScript.tip).toContain(t("run.widget.preparingScript"));
    expect(c.runProject.disabled).toBe(false);
  });

  it("running（脚本）：▶ 脚本置灰（已有脚本在运行），▶ 项目仍可用（可并行，§12）", () => {
    const c = computeRunWidget(s({ canRunScript: false, scriptDisabledReason: "已有脚本在运行（先停止）" }));
    expect(c.runScript.disabled).toBe(true);
    expect(c.runScript.tip).toBe(t("run.flow.scriptBusy"));
    expect(c.runProject.disabled).toBe(false);
  });

  it("running（项目）：▶ 项目可用（点击触发二选一 §6.4），▶ 脚本可用（不互斥）", () => {
    const c = computeRunWidget(s({ projectBusy: false, stopTarget: "项目" }));
    expect(c.runProject.disabled).toBe(false);
    expect(c.runScript.disabled).toBe(false);
    expect(c.stop.disabled).toBe(false);
    expect(c.stop.tip).toContain("项目");
  });

  it("多实例：⏹ 停最近启动（stopTarget 显示实例标签），⏹ tip 带快捷键", () => {
    const c = computeRunWidget(s({ stopTarget: "项目 2" }));
    expect(c.stop.disabled).toBe(false);
    expect(c.stop.tip).toBe(t("run.widget.stopRun", { target: "项目 2" }));
    expect(c.stop.tipKey).toBe("Ctrl+F2");
  });

  it("调试态：⏹ 路由停止调试（tip = 停止调试）", () => {
    const c = computeRunWidget(s({ debugging: true, stopTarget: null }));
    expect(c.stop.disabled).toBe(false);
    expect(c.stop.tip).toBe(t("run.widget.stopDebug"));
  });

  it("调试态：脚本运行拒绝（§13.2 互斥），项目运行放行", () => {
    const c = computeRunWidget(s({
      debugging: true,
      canRunScript: false,
      scriptDisabledReason: "调试进行中，请先停止调试",
    }));
    expect(c.runScript.disabled).toBe(true);
    expect(c.runScript.tip).toBe(t("run.flow.debugging"));
    expect(c.runProject.disabled).toBe(false);
  });

  it("exited：全部恢复可用（⏹ 除外——无在跑实例）", () => {
    const c = computeRunWidget(s({ stopTarget: null }));
    expect(c.runScript.disabled).toBe(false);
    expect(c.runProject.disabled).toBe(false);
    expect(c.stop.disabled).toBe(true);
  });
});
