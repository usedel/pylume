// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import DOMPurify from "dompurify";
import {
  classifyLink,
  isMarkdownPath,
  renderMarkdownToHtml,
  resolveMarkdownLinkPath,
  rewriteImageSrcs,
  sanitizeHtml,
  schedulePreviewRender,
  setPreviewOpen,
  shouldShowPreview,
} from "../markdownPreview";
import { app, type Tab } from "../state";

// happy-dom 的 DOM 实现不完整，DOMPurify 在测试环境无法端到端执行真实的 XSS 剥离
// （其依赖的若干浏览器 DOM 语义缺失），故这里 mock 成 identity；真实消毒能力由 DOMPurify
// 上游保证，生产（WebView2）正常。我们的单元测试聚焦：sanitizeHtml 是否委托 DOMPurify.sanitize，
// 以及 renderMarkdownToHtml 的「marked → sanitize → 图片改写」编排是否正确。
vi.mock("dompurify", () => ({
  default: { sanitize: vi.fn((s: string) => s) },
}));

function mdTab(path: string): Tab {
  return { path, model: { getValue: () => "# title" } as Tab["model"], dirty: false };
}

function ensurePreviewDom(): HTMLElement {
  let el = document.getElementById("md-preview");
  if (!el) {
    el = document.createElement("div");
    el.id = "md-preview";
    document.body.appendChild(el);
  }
  return el;
}

beforeEach(() => {
  // renderMarkdown 的代码高亮会访问 app.monaco；mock 成恒返回空，防 getter 抛「未初始化」
  app.monaco = { editor: { colorize: vi.fn(async () => "") } } as unknown as typeof import("monaco-editor/esm/vs/editor/editor.api");
  app.activeTab = null;
  ensurePreviewDom();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  app.activeTab = null;
});

describe("isMarkdownPath / classifyLink 链接与文件判定", () => {
  it(".md / .markdown 大小写不敏感", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("a.MD")).toBe(true);
    expect(isMarkdownPath("docs/x.markdown")).toBe(true);
    expect(isMarkdownPath("a.py")).toBe(false);
  });

  it("链接分类：锚点 / 外链 / 相对 md / 其他", () => {
    expect(classifyLink("#anchor")).toBe("anchor");
    expect(classifyLink("https://example.com")).toBe("external");
    expect(classifyLink("http://example.com/a")).toBe("external");
    expect(classifyLink("other.md")).toBe("relative-md");
    expect(classifyLink("sub/other.markdown")).toBe("relative-md");
    expect(classifyLink("readme.md#sec")).toBe("relative-md");
    expect(classifyLink("mailto:a@b.com")).toBe("other");
    expect(classifyLink("javascript:alert(1)")).toBe("other");
  });

  it("相对 md 链接 → 绝对路径（剥离 fragment/query）", () => {
    expect(resolveMarkdownLinkPath("other.md#sec", "F:\\proj\\docs")).toBe("F:\\proj\\docs\\other.md");
    expect(resolveMarkdownLinkPath("sub/x.md?q=1", "/mnt/d")).toBe("/mnt/d/sub/x.md");
  });
});

describe("消毒 sanitizeHtml（委托 DOMPurify.sanitize）", () => {
  it("把输入交给 DOMPurify.sanitize 并返回其结果", () => {
    const sanitizeMock = DOMPurify.sanitize as unknown as Mock;
    sanitizeMock.mockReturnValueOnce("<p>已消毒</p>");
    expect(sanitizeHtml("<p>原始</p><script>alert(1)</script>")).toBe("<p>已消毒</p>");
    expect(sanitizeMock).toHaveBeenCalledWith("<p>原始</p><script>alert(1)</script>");
  });
});

describe("图片改写 rewriteImageSrcs", () => {
  it("相对路径 → asset URL；data: 保留；http(s) 不动", () => {
    const toAsset = (p: string) => `asset://${p}`;
    const out = rewriteImageSrcs(
      `<img src="img/a.png"><img src="data:image/png;base64,xxx"><img src="https://example.com/x.png">`,
      "F:\\proj\\docs",
      toAsset,
    );
    expect(out).toContain("asset://F:\\proj\\docs\\img\\a.png");
    expect(out).toContain("data:image/png;base64,xxx");
    expect(out).toContain("https://example.com/x.png");
  });

  it("renderMarkdownToHtml 整合：marked → 消毒 → 图片改写", () => {
    const out = renderMarkdownToHtml("# Hi\n\n![a](pic.png)", "D:\\proj", (p) => `asset://${p}`);
    expect(out).toContain("<h1");
    expect(out).toContain("asset://D:\\proj\\pic.png");
  });
});

describe("显隐 shouldShowPreview", () => {
  it("非 md tab 隐藏；md tab 仅在开关开启时显示", () => {
    expect(shouldShowPreview(null, true)).toBe(false);
    expect(shouldShowPreview(mdTab("a.py"), true)).toBe(false);
    expect(shouldShowPreview(mdTab("a.md"), true)).toBe(true);
    expect(shouldShowPreview(mdTab("a.md"), false)).toBe(false);
  });
});

describe("防抖 schedulePreviewRender", () => {
  it("连续触发只渲染一次（fake timers）", () => {
    vi.useFakeTimers();
    const getValue = vi.fn(() => "# hi");
    app.activeTab = { path: "a.md", model: { getValue } as unknown as Tab["model"], dirty: false };
    setPreviewOpen(true); // 开启预览（内部可能立即渲染一次，属开关语义，不计入防抖）
    getValue.mockClear();

    schedulePreviewRender(300);
    schedulePreviewRender(300);
    schedulePreviewRender(300);

    vi.advanceTimersByTime(299);
    expect(getValue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(getValue).toHaveBeenCalledTimes(1);
  });
});