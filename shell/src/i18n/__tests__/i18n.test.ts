// @vitest-environment happy-dom
// i18n 运行时 + 后端错误翻译层的交互不变量。
// 环境用 happy-dom：applyDomI18n 要遍历带 data-i18n* 的真实元素，且模块内 localStorage 读写
// 需要宿主提供（缺 localStorage 时 i18n 回落默认语言，不应抛错——见 index.ts 的 try/catch）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDomI18n, getLocale, initI18n, onLocaleChange, setLocale, t } from "..";
import { localizeBackendError } from "../backendError";
import { enUS } from "../locales/en-US";
import { zhCN, zhDomains } from "../locales/zh-CN";

describe("语言包完整性", () => {
  it("中英文 key 集合完全一致（编译期 Record<TKey,string> 之外的第二道锁）", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it("各域 key 前缀互不相同（跨域重复会被 spread 静默覆盖，扫 spread 前的域表兜底）", () => {
    const owner = new Map<string, string>();
    for (const [domain, table] of Object.entries(zhDomains)) {
      for (const k of Object.keys(table)) {
        const prev = owner.get(k);
        expect(prev ?? undefined, `key "${k}" 同时出现在 ${prev} 域与 ${domain} 域（后者覆盖前者）`).toBeUndefined();
        owner.set(k, domain);
      }
    }
  });

  it("词条无空串占位（漏填会让 UI 出现空白按钮）", () => {
    for (const [k, v] of Object.entries(zhCN)) expect(v.trim(), k).not.toBe("");
    for (const [k, v] of Object.entries(enUS)) expect(v.trim(), k).not.toBe("");
  });
});

describe("t() 取词与插值", () => {
  beforeEach(() => setLocale("zh-CN"));
  afterEach(() => setLocale("zh-CN"));

  it("默认语言为中文（存量中文断言用例的前提）", () => {
    expect(getLocale()).toBe("zh-CN");
    expect(t("menubar.file")).toBe("文件");
  });

  it("切英文后同一 key 返回英文", () => {
    setLocale("en-US");
    expect(t("menubar.file")).toBe("File");
  });

  it("{param} 插值，未提供的占位原样保留", () => {
    setLocale("en-US");
    expect(t("toast.failSuffix", { action: "Save", reason: "disk full" })).toBe("Save failed: disk full");
    expect(t("toast.failSuffix", { action: "Save" })).toContain("{reason}");
  });

  it("按语言选择复数变体，中文保持同文", () => {
    setLocale("en-US");
    expect(t("git.discard.confirmMany", { count: 1 })).toBe("Discard changes in 1 file? This cannot be undone.");
    expect(t("git.discard.confirmMany", { count: 2 })).toBe("Discard changes in 2 files? This cannot be undone.");
    setLocale("zh-CN");
    expect(t("git.discard.confirmMany", { count: 2 })).toBe("确定丢弃 2 个文件的更改吗？此操作不可撤销。");
  });

  it("调试域词条和复数变体可用", () => {
    expect(t("debug.toolbar.continue")).toBe("继续");
    setLocale("en-US");
    expect(t("debug.toolbar.continue")).toBe("Continue");
    expect(t("debug.watch.limit", { count: 1 })).toContain("1 watch");
    expect(t("debug.watch.limit", { count: 2 })).toContain("2 watches");
  });

  it("未知 key 回落 key 本身（不返回 undefined / 空串）", () => {
    // 刻意绕过类型：模拟语言包尚未同步的中间态
    expect(t("no.such.key" as never)).toBe("no.such.key");
  });
});

describe("applyDomI18n 静态骨架套用", () => {
  afterEach(() => {
    setLocale("zh-CN");
    document.body.innerHTML = "";
  });

  it("按 data-i18n* 改写文本 / tip / aria / placeholder", () => {
    document.body.innerHTML = `
      <button id="a" data-i18n="menubar.file" data-i18n-tip="menubar.settings"
              data-i18n-aria="menubar.settings" aria-label="设置">文件</button>
      <input id="b" data-i18n-ph="search.searchInput" placeholder="搜索工作区…" />
      <span id="c" data-i18n-title="tree.outlineTitle" title="大纲"></span>`;
    applyDomI18n(document);
    const a = document.getElementById("a")!;
    expect(a.textContent).toBe("文件"); // 默认 zh-CN：与 HTML 里的原值一致
    expect(a.getAttribute("data-tip")).toBe("设置");
    expect(a.getAttribute("aria-label")).toBe("设置");
    expect(document.getElementById("b")!.getAttribute("placeholder")).toBe("搜索工作区…");
    expect(document.getElementById("c")!.getAttribute("title")).toBe("大纲");

    setLocale("en-US");
    expect(a.textContent).toBe("File");
    expect(a.getAttribute("data-tip")).toBe("Settings");
    expect(a.getAttribute("aria-label")).toBe("Settings");
  });

  it("写文本时保留图标子元素（只替换文本节点）", () => {
    document.body.innerHTML = `<button id="d" data-i18n="menubar.help"><i class="codicon"></i>帮助</button>`;
    applyDomI18n(document);
    const d = document.getElementById("d")!;
    expect(d.querySelector("i")).not.toBeNull();
    expect(d.textContent).toBe("帮助");
  });

  it("initI18n 同步 <html lang>", () => {
    initI18n();
    expect(document.documentElement.lang).toBe("zh-CN");
    setLocale("en-US");
    expect(document.documentElement.lang).toBe("en-US");
  });
});

describe("语言切换广播", () => {
  afterEach(() => setLocale("zh-CN"));

  it("订阅者收到通知；取消订阅后不再收到", () => {
    let hits = 0;
    const off = onLocaleChange(() => hits++);
    setLocale("en-US");
    expect(hits).toBe(1);
    off();
    setLocale("zh-CN");
    expect(hits).toBe(1);
  });

  it("同值重复切换不广播（避免连点触发 N 次全量重绘）", () => {
    let hits = 0;
    const off = onLocaleChange(() => hits++);
    setLocale("zh-CN");
    expect(hits).toBe(0);
    off();
  });

  it("单个订阅者抛错不中断其余订阅者", () => {
    const seen: string[] = [];
    const offBad = onLocaleChange(() => {
      throw new Error("boom");
    });
    const offGood = onLocaleChange(() => seen.push("ok"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setLocale("en-US");
    expect(seen).toEqual(["ok"]); // 后注册的订阅者仍被执行
    spy.mockRestore();
    offBad();
    offGood();
  });
});

describe("后端错误翻译层", () => {
  afterEach(() => setLocale("zh-CN"));

  it("中文环境下原样返回（默认路径零改动，存量断言不受影响）", () => {
    expect(localizeBackendError("工作区目录不存在：/tmp/x")).toBe("工作区目录不存在：/tmp/x");
  });

  it("英文环境下命中模板并回填参数", () => {
    setLocale("en-US");
    expect(localizeBackendError("工作区目录不存在：/tmp/x")).toBe("Workspace directory does not exist: /tmp/x");
    expect(localizeBackendError("分支名不能为空")).toBe("Branch name cannot be empty");
    expect(localizeBackendError("命令执行超时（30s）")).toBe("Command timed out (30s)");
  });

  it("多参数模板按序回填", () => {
    setLocale("en-US");
    expect(localizeBackendError("删除文件失败：a.py（permission denied）")).toBe(
      "Failed to delete file: a.py (permission denied)",
    );
  });

  it("未命中模板时原样返回（宁可露中文也不吞掉错误）", () => {
    setLocale("en-US");
    const raw = "某种全新的后端错误：xyz";
    expect(localizeBackendError(raw)).toBe(raw);
  });

  it("空串与 undefined 安全", () => {
    setLocale("en-US");
    expect(localizeBackendError("")).toBe("");
  });
});
