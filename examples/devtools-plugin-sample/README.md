# Pylume 开发工具插件 · 示例

这是一个**可直接安装**的示例插件：ROT13（面板 + inline 双模式）+ 字数统计（纯面板）。

## 安装体验

1. 找到 Pylume 数据根目录（默认 `%LOCALAPPDATA%\Pylume`）；
2. 复制本目录到 `<数据根>/extensions/com.example.sample-tools/`（目录名必须 = manifest 的 `id`）；
3. 启动/重启 Pylume（或 设置 → 插件 → 重新扫描）；
4. 验证：
   - 菜单「工具 → 文本 ▸」出现「ROT13」「字数统计」；
   - `Ctrl+Shift+T` 打开工具面板 → picker 可搜到；
   - 编辑器选中文本 → 命令面板（Double Shift）搜「ROT13 选区」→ 原地替换，toast 可撤销；
   - 设置 → 插件：示例插件行可展开/停用/重载。

## 目录结构

```
com.example.sample-tools/
├─ pylume.plugin.json   # manifest（schemaVersion 1）
├─ rot13.js                # 工具 1：mount + rot13Selection（inline handler）
└─ word-count.js           # 工具 2：仅 mount
```

## 写你自己的插件

完整规范（manifest 字段、host API、权限、热重载语义）原在插件作者指南中，
该文档已随 2026-10-04 的 docs 精简归档；当前以本示例的 `pylume.plugin.json`
与两个 `.js` 为准，验收口径见 `docs/devtools_plugin_acceptance_record.md`。
