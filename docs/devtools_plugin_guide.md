# Pylume 开发工具插件 · 作者指南

> 版本：v1（对应 `docs/plugin_system_design.md` §9 工具切片 · schemaVersion 1）· 2026-09-20
> 适用：想给 Pylume 写「开发小工具」（编码 / 哈希 / 格式化 / 转换 / 提取等）的插件作者。
> 可运行样例：`examples/devtools-plugin-sample/`（复制即用）。

---

## 〇、分享你的插件（P2）

写好的插件想发给别人？**设置 → 插件 → 展开你的插件行 → 「导出」**——选保存位置，
得到 `<id>-<version>.zip`（自动跳过隐藏文件与 node_modules 等噪声）。对方在
**设置 → 插件 → 「导入插件…」** 选择这个 zip 即可安装。

导入端校验（安全）：zip 必须只有一个顶层目录（= 插件 id，与 manifest.id 一致）、
条目不得路径逃逸、单文件 ≤ 10MB；同名插件已存在会**拒绝覆盖**（更新请先删旧版）。

## 一、5 分钟上手

**最快路径（推荐）**：设置 → 插件 → **「新建插件…」**——填 id 和名称，Pylume 落盘一份
「注释即教程」的模板（面板 + inline + host.log 全演示），自动加载。然后打开插件目录改
`hello.js`，**保存即热重载**。

手动路径：

1. **建目录**：`<数据根>/extensions/<你的插件id>/`（设置 → 插件 页顶部有**真实路径**与「复制路径」按钮；**目录名必须等于 manifest 的 `id`**）。
2. **写 manifest**（`pylume.plugin.json`）：

```jsonc
{
  "schemaVersion": 1,
  "id": "com.yourname.your-tools",
  "name": "你的工具集",
  "version": "0.1.0",
  "engines": { "pylume": ">=0.1.0" },
  "contributes": {
    "tools": [
      {
        "id": "my-tool",
        "title": "我的工具",
        "description": "一句话说明（picker 副标题）",
        "category": "编码",
        "icon": "key",
        "entry": "./my-tool.js",
        "inline": { "label": "我的变换选区", "handler": "mySelection" }
      }
    ]
  },
  "permissions": ["clipboard", "selection"]
}
```

3. **写工具模块**（`my-tool.js`，ES module，**单文件、不要 import 插件内其他文件**）：

```js
export function mount(host) {
  const { kit } = host;
  const input = kit.textarea({ placeholder: "输入…", flex: true });
  const out = kit.output({ placeholder: "结果" });
  const go = kit.primaryButton("运行", "play", () => out.set(transform(input.value)));
  host.root.append(input, kit.toolbar(go, "spacer", kit.copyButton(() => out.get())), out.el);
}

export function mySelection(text) {
  return transform(text); // inline：选区 → 返回替换文本；抛错则保留原文
}
```

4. **安装**：重启 Pylume（或 设置 → 插件 → 重新扫描）。完成。

---

## 二、Manifest 字段（schemaVersion 1）

| 字段 | 必填 | 约束 |
|---|---|---|
| `schemaVersion` | ✓ | 固定 `1` |
| `id` | ✓ | `字母数字开头` 的点分/连字符名（建议反向域名）；**必须与目录名一致** |
| `name` / `version` | ✓ | 非空字符串 |
| `engines.pylume` | ✓ | 仅支持 `">=X.Y.Z"` 一种形式 |
| `contributes.tools[]` | ✓ | 至少 1 个；空数组 = 校验失败 |
| `permissions[]` | — | 白名单见 §四；**未知值（含拼错）= 校验失败** |
| 工具 `id`/`title`/`entry` | ✓ | `entry` 相对 manifest 的路径 |
| 工具 `category` | — | 预置有序集：`编码 / 哈希 / 格式化 / 转换 / 生成 / 提取 / 文本 / 其他`；自定义值按字母序排在「其他」之前 |
| 工具 `icon` | — | codicon 名（如 `json` / `key` / `lock`），缺省 `symbol-extension` |
| 工具 `inline` | — | `{ label, handler }`；`handler` = 模块导出的函数名 |

**校验失败的插件**：整包不加载（不会半加载），设置 → 插件 里红字显示原因。

## 三、工具模块契约

- **至少实现其一**：`mount(host)`（面板模式）或 `inline.handler`（就地变换）；
- **单文件 entry**：`entry` 模块不得 `import` 插件包内其他文件（热重载按入口粒度 cache-bust，多文件依赖会拿到旧代码）；浏览器全局（`crypto` / `TextEncoder` 等）与 kit/host 提供的能力随便用；
- **只通过 `host` 与外壳交互**：禁止 import Pylume 内部模块（`shell/src/**`）——这是 API facade 硬约束，v2 沙箱化后违反即坏；
- `mount` 返回 `{ dispose() {} }` 可省略；有 Monaco 实例/定时器/监听器时**必须**在 `dispose` 清理；
- `inline.handler(text, host)` 返回 `string`（同步或 `Promise<string>`）；抛错 = toast 报错 + **保留原文**；
- inline 触发时**面板可能从未打开**——`inline.handler` 收到的 `host` **没有** `root` / `kit` / `monaco`；
- **inline 触发入口（无需配置，声明即生效）**：命令面板搜 `inline.label`、编辑器**选中文本后右键 → 「变换选区 ▸」** 子菜单（有选区才显示，无选区自动隐藏）。

## 四、host API 与权限

未声明的权限 → 调用时抛 `PermissionDeniedError`（设置 → 插件 日志可见）。

| API | 权限 | 说明 |
|---|---|---|
| `host.toast(msg, "info"\|"ok"\|"error")` | 默认 | 轻提示 |
| `host.log(msg)` | 默认 | 调试日志 → 设置 → 插件 → 日志面板（release 唯一输出通道） |
| `host.root`（面板） | 默认 | 工具内容容器（**每工具独立**，勿跨工具假设） |
| `host.kit.*`（面板） | 默认 | UI 积木，见 §五 |
| `host.copyToClipboard(text)` / `host.readClipboard()` | `clipboard` | 复制 / 读剪贴板 |
| `host.getSelectedText()` / `host.replaceSelection(text)` / `host.insertToEditor(text)` | `selection` | 选区读取 / 原地替换（无选区=光标处插入）/ 插入文档末尾 |
| `host.storage.get/set/clear(key)` | `storage` | 插件私有命名空间（`pylume.plugin.<id>.` 前缀），停用时清空 |
| `host.workspaceRoot()` / `host.readFile(rel)` | `fs:read` | 工作区根 / 读**插件目录内**相对路径文件（路径越界拒绝） |
| `host.monaco`（面板） | `monaco` | 裸 Monaco 模块。**一般不需要**——预览用 `kit.output` 即可（无权限也可用） |

## 五、kit UI 积木（面板模式）

| 积木 | 说明 |
|---|---|
| `kit.body()` | 根容器（flex column + gap），挂到 `host.root` |
| `kit.row(...els)` / `kit.toolbar(...items)` | 横向行 / 工具栏；字符串 `"spacer"` = 撑开占位 |
| `kit.radioGroup({ label, options, value, onChange })` | **互斥单选组**（WAI-ARIA radiogroup：圆点指示 + 方向键移动即选中 + 组内单 tab stop）；返回 `{ el, get() }`。方向/算法/缩进等二选一场景用它，别用两个 `.active` 按钮 |
| `kit.textarea({ placeholder, flex, rows, onInput })` | 多行输入（自动 `autocomplete=off`+`spellcheck=false`；`flex:true` 纵向撑满） |
| `kit.input({ placeholder, type, readOnly, onInput, onEnter })` | 单行输入 |
| `kit.output({ language, readOnly, placeholder })` | Monaco 封装：`{ el, get(), set(), clear(), dispose() }`；自动跟随用户字号/主题/减少动画 |
| `kit.button(label, icon?, onClick)` / `kit.primaryButton(...)` | 标准按钮 / 主按钮 |
| `kit.iconButton(icon, tip, onClick)` | 图标按钮（tooltip + aria 自动补） |
| `kit.copyButton(getText)` / `kit.pasteButton(setText)` / `kit.clearButton(...targets)` | 带 flash 反馈的复制 / 粘贴 / 清空 |
| `kit.errorSlot()` | 红字错误槽（占位高度防跳动） |
| `kit.icon(name)` / `kit.flash(btn, "ok"\|"error", text)` | codicon 图标 / 按钮 flash |

按钮**切换态**分两种语义：
- **互斥选择**（编码/解码、算法选择等）→ 用 `kit.radioGroup`（上面的单选组），不要自己拼 `.active` 按钮；
- **独立开关**（如「大写」）→ 自己维护：`btn.classList.toggle("active", on)` + `btn.setAttribute("aria-pressed", String(on))` 同源切换。

## 六、加载 / 热重载 / 生命周期

- **发现**：启动扫描 `<数据根>/extensions`（仅此一处；工作区级目录 v2 再开）；
- **懒激活**：工具被打开才 `mount`；面板内切换有实例缓存（LRU ≤5，超限自动 dispose）；
- **热重载**：目录变化 → 去抖 400ms → 全量 diff（manifest/entry 内容）→ 受影响插件整包重载；面板正打开该工具会回到选择器；toast「插件已重新加载」；
- **停用/启用**：设置 → 插件；停用即注销工具 + 清空 storage 命名空间（文件保留）；
- **错误隔离**：一个插件加载失败不影响其他插件与内置工具。

## 七、调试技巧

- **`host.log("...")` 是你的调试主力**：release 版没有浏览器控制台，`host.log` 写入
  设置 → 插件 → 你的插件行 → 展开后的**日志面板**（默认权限，无需声明）；
  每条日志同时**落盘**到 `<数据根>/logs/plugins/<你的插件id>.log`（跨重启可查，
  64KB 滚动截断）——设置 → 插件 页顶部有数据根真实路径与「复制路径」按钮；
- **inline 工具免选区调试**：声明 inline（且无 mount）的工具在面板打开时自动获得
  **调试台**——输入文本 → 「运行」→ 结果/错误就地显示，不用去编辑器选文本；
- **VS Code 类型补全**：脚手架生成的插件目录带 `pylume-plugin.d.ts`——entry 首行
  已有 `// @ts-check`，用 VS Code 打开即获得 `host`/`kit` 的完整补全与检查；
- `console.log/warn` 仅 dev 模式（`tauri dev`）的 WebView 控制台可见，release 不可达；
- 改完 entry 文件**保存即热重载**，无需重启（面板正打开的工具会以新代码重挂）；
- 校验/加载错误看 设置 → 插件 → 展开行（红字原因 + 日志）；
- 权限拒绝有运行日志（`权限拒绝: xxx() 需要 "yyy"`）。

## 八、信任模型（重要，请作者知悉）

v1 是**同源加载**（无硬沙箱）：你写的插件与 Pylume 主界面同一运行环境，理论上可访问页面 DOM——因此 Pylume 的信任边界是「**你安装你信任的插件**」（对齐 VS Code）。请：

- 只从信任的来源安装插件；
- 发布插件时请勿做破坏 facade 契约的事（读写他人 DOM、绕过 host 直接调系统）——v2 沙箱化后这些行为会被硬性阻断，你的插件会坏。

---

*指南随切片演进更新；规范冲突时以 `docs/plugin_system_design.md` §9 为准。*
