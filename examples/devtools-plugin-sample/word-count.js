// 示例工具 2：字数统计（纯面板模式，无 inline）。
// 演示：不申请 selection 权限的面板工具；kit.output 用 plaintext 即可（无语法高亮需求）。

export function mount(host) {
  const { kit } = host;
  host.root.textContent = "";

  const wrap = kit.body();
  const input = kit.textarea({ placeholder: "粘贴或输入文本…", flex: true });

  const stat = () => {
    const text = input.value;
    const chars = [...text].length; // 码点数（中文 1 字 = 1）
    const words = (text.match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]/g) ?? []).length; // 英文词 + 单个汉字
    const lines = text === "" ? 0 : text.split("\n").length;
    out.set(`字符：${chars}\n单词/汉字：${words}\n行数：${lines}`);
  };

  const statBtn = kit.primaryButton("统计", "symbol-count", stat);
  input.addEventListener("input", stat); // 即时统计

  const out = kit.output({ placeholder: "统计结果" });
  wrap.append(
    input,
    kit.toolbar(statBtn, "spacer", kit.copyButton(() => out.get())),
    out.el,
  );
  host.root.appendChild(wrap);
  stat();
}
