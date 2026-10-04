// @vitest-environment happy-dom
// CR-04 回归：storagePanel 渲染必须走 DOM API + textContent，
// 恶意路径 / hash / 错误串不得经 innerHTML 逃逸出属性或注入脚本节点。
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as StoragePanelModule from "../storagePanel";
import { t } from "../i18n"; // 断言走 t(key)：默认中文等价于原文断言，切默认语言也不用改

let sp: typeof StoragePanelModule;
let usageEl: HTMLElement;

/** 构造含 HTML 注入载荷的用法数据（覆盖 title 属性逃逸 / 元素注入 / 事件处理器三类向量） */
function maliciousUsage() {
  return {
    data_root: 'C:\\Users\\"><img src=x onerror=window.__pwned=1>\\Data',
    entries: [
      {
        key: "traces",
        label: '<script>window.__pwned=1</script>',
        path: 'C:\\evil" onmouseover="window.__pwned=1\\traces',
        size_bytes: 12345,
        renewable: "yes",
      },
    ],
    traces: [
      {
        hash: '"><svg onload=window.__pwned=1>',
        path: "C:\\evil' onclick=\"window.__pwned=1\\t.db",
        size_bytes: 678,
      },
    ],
    uv: [
      {
        label: "<b>uv</b> 缓存 & '<script>'",
        path: 'C:\\u&v\\"><iframe src=javascript:alert(1)>',
        size_bytes: 999,
      },
    ],
  };
}

beforeAll(async () => {
  // storagePanel.ts 模块顶层捕获 #storage-* 元素，须先备好 DOM 再动态导入
  const ensure = (id: string, tag: string) => {
    if (!document.getElementById(id)) {
      const el = document.createElement(tag);
      el.id = id;
      document.body.appendChild(el);
    }
  };
  ensure("storage-usage", "div");
  ensure("storage-root-path", "span");
  ensure("storage-migrate-path", "input");
  ensure("storage-onboarding-modal", "div");

  vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
  sp = await import("../storagePanel");
  usageEl = document.getElementById("storage-usage")!;
});

describe("CR-04 storagePanel 渲染安全（DOM API，无 innerHTML 注入）", () => {
  it("renderUsage 不执行注入载荷：无脚本节点、属性不逃逸、文本如实显示", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(maliciousUsage());
    await sp.loadStorageUsage();

    // ① 无脚本类节点被解析执行（innerHTML 拼接则会成为真实元素）
    expect(usageEl.querySelector("script")).toBeNull();
    expect(usageEl.querySelector("img")).toBeNull();
    expect(usageEl.querySelector("svg")).toBeNull();
    expect(usageEl.querySelector("iframe")).toBeNull();
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();

    // ② title 属性未逃逸：含 " 的路径只落在 title 内，不产生 onmouseover 等属性
    const rows = Array.from(usageEl.querySelectorAll(".storage-row"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const attrs = Array.from(row.attributes).map((a) => a.name);
      expect(attrs.every((n) => n === "class" || n === "title")).toBe(true);
      expect(row.hasAttribute("onmouseover")).toBe(false);
    }

    // ③ 序列化结果不含注入标签（字面 <script> 已转义）
    const html = usageEl.innerHTML;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");

    // ④ label 仍是纯文本（<script> 字符串可见但不执行）
    const label = usageEl.querySelector(".storage-label")!;
    expect(label.textContent).toBe("<script>window.__pwned=1</script>");

    // ⑤ trace 删除按钮 data-trace 如实携带 hash 字面值
    // （UI-08 后按钮外观走通用 .btn 体系，选择器改用属性钩子 [data-trace]，与生产代码的事件委托同口径）
    const del = usageEl.querySelector<HTMLButtonElement>("[data-trace]")!;
    expect(del.dataset.trace).toBe('"><svg onload=window.__pwned=1>');

    // ⑥ 尺寸徽章等正常渲染
    expect(usageEl.querySelector(".storage-size")?.textContent).toBe("12.1 KB");
    expect(usageEl.querySelector(".storage-badge-ok")?.textContent).toBe(t("storage.tag.renewable"));
    expect(usageEl.querySelector(".storage-sep")?.textContent).toContain("uv");
  });

  it("加载失败：错误串以纯文本呈现（不再 innerHTML 拼接）", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom "<script>alert(1)</script>"'),
    );
    await sp.loadStorageUsage();
    expect(usageEl.querySelector("script")).toBeNull();
    expect(usageEl.textContent).toContain('boom "<script>alert(1)</script>"');
  });
});
