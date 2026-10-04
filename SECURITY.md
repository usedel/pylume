# 安全政策

## 支持版本

| 版本 | 是否支持 |
|---|---|
| 主干 `master` | ✅ |
| v0.1.0 | ✅ |

本项目由个人维护，无法承诺企业级 SLA，但会认真对待每一份报告。

## 如何报告

**请不要开公开 issue。** 请通过以下任一方式私下联系：

1. GitHub 的 **Security Advisory**（仓库 → Security → Report a vulnerability），或
2. 公众号 / 邮件联系维护者。

请附上：影响版本、复现步骤、影响面（是否需要本地文件 / 特定项目结构）、以及你有 PoC 的话一并给出。

**响应预期**：48 小时内确认收到；确认后给出修复计划与时间；修复后在同一渠道通知你，并征得同意后再公开致谢。

## 本项目的安全相关设计

这些是刻意的设计选择，报告时可作为参考：

- **调试器不监听固定端口**：DAP 走 stdio adapter 模式（Rust spawn `python <debugpy>/adapter`，管道通信），被调试脚本经 `--connect` 连 adapter 的 server socket，该 socket 绑定 `127.0.0.1` 且端口由系统分配（`port: 0`）。不暴露局域网端口。
- **不写用户环境**：debugpy 以包目录作脚本参数拉起，`sys.path[0]` 自举后立即删除注入项；用户 `site-packages` 零写入、切换 venv 无感。**永不**用 `pip install` 把 debugpy 装进用户环境。
- **探针默认关闭**：只在环境变量 `PYLUME_PROBE_AUTOSTART=1` 时激活；未设置则对用户进程零介入。探针任何失败只打警告，**不改写用户进程退出码**。
- **绝不 repr 值**：运行时采样只记录类型的紧凑表示与 shape 指纹，不记录变量值——trace 库里没有你的业务数据。
- **trace 库落在用户目录**：`~/.pylume/traces/<project-hash>.db`，不随项目分发。

## 已知的风险面（欢迎报告）

- 外壳会 spawn 进程：PTY（`portable-pty`）、git、python、`uv`。命令拼接与工作目录锚定是重点。
- 工具插件（`examples/devtools-plugin-sample/`）当前是 v1 信任模型，加载外部插件包等同执行代码——v2 沙箱未启动。
- Monaco 渲染 Markdown 预览走 DOMPurify 清洗。
- SQLite 工具默认只读打开用户的 `.db` 文件。

## 不在范围内

- 第三方依赖自身的已知漏洞：请开普通 issue 说明依赖名与版本，我们会在 `ci/versions.toml` 升级流程中处理。
- 刻意不做的能力（AI / 插件市场等）相关的"缺失"不是安全问题。
