// @vitest-environment happy-dom
// UX P0-3 回归（M3-3.4 四控件）：运行组按钮的禁用态必须用 .is-disabled + aria-disabled，
// **不能用 disabled 属性**。原因同 debugView 工具栏：Chromium 不向禁用的表单控件派发
// 鼠标事件，data-tip 会静默失效，而「为什么不能运行」的原因文案恰是灰按钮最需要展示的信息。
import { beforeAll, describe, expect, it } from "vitest";
import type * as RunWidgetModule from "../runWidget";
import type { RunWidgetState } from "../runWidget";
import { t } from "../i18n"; // 断言走 t(key)：默认中文等价于原文断言，切默认语言也不用改

let rw: typeof RunWidgetModule;

const IDS = ["btn-run-script", "btn-run-project", "btn-stop", "btn-run-config"];

function state(partial: Partial<RunWidgetState>): RunWidgetState {
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

beforeAll(async () => {
  // renderRunWidget 走 lazyEl 解析 DOM，须先备好四个按钮再动态导入。
  // 内部 <i> 图标类与 index.html 静态结构一致（▶ / ▶▶ / ⏹ / ⚙），
  // 图标不变量回归（applyButton 的 busy 切换不得污染其它按钮）依赖这一点。
  const icons: Record<string, string> = {
    "btn-run-script": "codicon-run",
    "btn-run-project": "codicon-run-all",
    "btn-stop": "codicon-debug-stop",
    "btn-run-config": "codicon-gear",
  };
  for (const id of IDS) {
    if (!document.getElementById(id)) {
      const b = document.createElement("button");
      b.id = id;
      const i = document.createElement("i");
      i.className = `codicon ${icons[id]}`;
      b.appendChild(i);
      document.body.appendChild(b);
    }
  }
  rw = await import("../runWidget");
});

describe("运行组禁用态（UX P0-3：.is-disabled + aria-disabled，保留 data-tip）", () => {
  it("无工作区：四按钮 .is-disabled + aria-disabled=true，disabled 属性保持 false，data-tip 保留原因", () => {
    rw.renderRunWidget(state({
      hasWs: false,
      canRunScript: false,
      scriptDisabledReason: "未打开工作区",
      canRunProject: false,
      projectDisabledReason: "未打开工作区",
      canOpenConfig: false,
    }));
    for (const id of IDS) {
      const b = document.getElementById(id) as HTMLButtonElement;
      expect(b.disabled, `${id} 不应设 disabled 属性（会让 data-tip 静默失效）`).toBe(false);
      expect(b.classList.contains("is-disabled"), `${id} 应带 .is-disabled`).toBe(true);
      expect(b.getAttribute("aria-disabled"), `${id} 应有 aria-disabled=true`).toBe("true");
      expect(b.dataset.tip, `${id} 应保留 tooltip 文案`).toBeTruthy();
    }
    expect(document.getElementById("btn-run-script")!.dataset.tip).toBe(t("run.flow.noWorkspace"));
  });

  it("idle：▶ 脚本/▶ 项目/⚙ 清除禁用态，⏹ 仍禁用；aria-disabled 与类同源", () => {
    rw.renderRunWidget(state({}));
    for (const id of ["btn-run-script", "btn-run-project", "btn-run-config"]) {
      const b = document.getElementById(id) as HTMLButtonElement;
      expect(b.classList.contains("is-disabled"), `${id} 不应再带 .is-disabled`).toBe(false);
      expect(b.getAttribute("aria-disabled")).toBe("false");
    }
    const stop = document.getElementById("btn-stop") as HTMLButtonElement;
    expect(stop.classList.contains("is-disabled")).toBe(true);
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.dataset.tip).toBe(t("run.widget.notRunning"));
  });
});

describe("运行组图标不变量（busy 切换不得污染其它按钮）", () => {
  const iconClass = (id: string): string =>
    (document.getElementById(id)?.querySelector("i.codicon")?.className ?? "").trim();

  it("非 busy 渲染不改动任何按钮的图标类", () => {
    rw.renderRunWidget(state({}));
    expect(iconClass("btn-run-script")).toBe("codicon codicon-run");
    expect(iconClass("btn-run-project")).toBe("codicon codicon-run-all");
    expect(iconClass("btn-stop")).toBe("codicon codicon-debug-stop");
    expect(iconClass("btn-run-config")).toBe("codicon codicon-gear");
  });

  it("准备期仅对应 ▶ 切为旋转 loader；恢复后还原，其余按钮全程不变", () => {
    rw.renderRunWidget(state({ scriptPreparing: true }));
    expect(iconClass("btn-run-script")).toContain("codicon-loading");
    expect(iconClass("btn-run-script")).toContain("codicon-modifier-spin");
    expect(iconClass("btn-run-script")).not.toContain("codicon-run");
    expect(iconClass("btn-run-project")).toBe("codicon codicon-run-all");
    expect(iconClass("btn-stop")).toBe("codicon codicon-debug-stop");
    expect(iconClass("btn-run-config")).toBe("codicon codicon-gear");
    // 准备结束：▶ 还原
    rw.renderRunWidget(state({}));
    expect(iconClass("btn-run-script")).toBe("codicon codicon-run");
  });

  it("项目准备期：仅 ▶ 项目切 loader，▶ 脚本不变", () => {
    rw.renderRunWidget(state({ projectPreparing: true }));
    expect(iconClass("btn-run-project")).toContain("codicon-loading");
    expect(iconClass("btn-run-script")).toBe("codicon codicon-run");
  });

  it("项目 running（非 preparing）：▶ 项目保持可点不转 loader（点击触发二选一，§7.3 实测回归钉）", () => {
    rw.renderRunWidget(state({ projectBusy: true, projectPreparing: false, stopTarget: "项目" }));
    expect(iconClass("btn-run-project")).toBe("codicon codicon-run-all");
    const b = document.getElementById("btn-run-project") as HTMLButtonElement;
    expect(b.classList.contains("is-disabled")).toBe(false);
    expect(b.dataset.tip).toContain(t("run.widget.projectRunningTip"));
  });
});
