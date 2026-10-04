// 示例工具 1：ROT13（面板 + inline 双模式）。
// 这是 Pylume 开发工具插件的「最小完整样例」——复制本目录即可开始写你自己的插件。
// 契约要点（完整文档见 docs/devtools_plugin_guide.md）：
// - 只通过入参 host 与外壳交互，禁止 import Pylume 内部模块；
// - mount(host) 挂载面板 UI（host.root + host.kit 积木），返回 { dispose } 可省略；
// - inline handler（manifest 里声明的函数名）做「选中 → 变换 → 原地替换」，抛错则保留原文。

export function mount(host) {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const input = kit.textarea({ placeholder: "输入文本…", flex: true });
  const out = kit.output({ placeholder: "ROT13 结果" });

  const run = () => out.set(rot13(input.value));
  const runBtn = kit.primaryButton("变换", "play", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
  });

  // host.toast 需要 "info" | "ok" | "error"（示例：面板内提示）
  const helloBtn = kit.button("打个招呼", "bell", () => host.toast("来自示例插件的问候", "info"));

  wrap.append(
    input,
    kit.toolbar(runBtn, helloBtn, "spacer", kit.copyButton(() => out.get())),
    out.el,
  );
  host.root.appendChild(wrap);
}

/** ROT13：字母旋转 13 位（自逆；非字母原样） */
function rot13(text) {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** inline：选区 → ROT13（对应 manifest.inline.handler） */
export function rot13Selection(text) {
  return rot13(text);
}
