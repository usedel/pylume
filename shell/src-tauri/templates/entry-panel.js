// @ts-check
// 面板工具模板（脚手架生成）：一个「问候」工具，演示 kit 积木 + host.log。
// 开发循环：保存本文件 → 热重载（无需重启）。调试用 host.log（设置 → 插件 → 日志）。

/**
 * 面板模式：挂载 UI（工具被打开时调用一次）
 * @param {ToolHost} host
 * @returns {ToolInstance | void}
 */
export function mount(host) {
  const { kit } = host;
  const wrap = kit.body();

  const input = kit.textarea({ placeholder: "输入名字…", flex: true });
  const out = kit.output({ placeholder: "结果" });

  const greet = () => {
    const name = input.value.trim() || "世界";
    out.set("你好，" + name + "！");
    host.log("问候了：" + name);
  };

  const go = kit.primaryButton("问候", "play", greet);
  input.addEventListener("keydown", /** @param {KeyboardEvent} e */ (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) greet();
  });

  wrap.append(
    input,
    kit.toolbar(go, "spacer", kit.copyButton(() => out.get())),
    out.el,
  );
  host.root.appendChild(wrap);
  greet();
}
