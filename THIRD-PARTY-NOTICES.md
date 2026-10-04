# 第三方许可声明

Pylume 本体采用 [MIT](LICENSE)。本项目在**分发安装包**时包含下列第三方组件，此处汇总其许可证与义务。

> 维护约定：新增一个随包分发的第三方组件时，必须同步更新本文件；升级版本时核对许可证是否变化。

## 需要特别注意的两条

| 组件 | 许可证 | 为什么特别 |
|---|---|---|
| **@vscode/codicons** | **CC BY 4.0** | **不是 MIT**——CC BY 要求**署名**（作者 + 链接 + 许可证），这是最容易漏的一条 |
| **JetBrains Mono** | **SIL OFL 1.1** | 要求许可证文本随字体一起分发；仓库内 `shell/public/fonts/OFL.txt` 必须在打包产物中保留 |

其余大多为 MIT / Apache-2.0，义务仅为"保留版权与许可声明"。

## 前端（随应用分发）

| 组件 | 许可证 |
|---|---|
| monaco-editor | MIT |
| @xterm/xterm · @xterm/addon-fit | MIT |
| marked | MIT |
| dompurify | MPL-2.0 **或** Apache-2.0（二选一）；若修改其源码，该文件需按 MPL 公开 |
| @vscode/codicons | **CC BY 4.0**（需署名） |
| @tauri-apps/api · @tauri-apps/plugin-dialog | MIT / Apache-2.0 |

## 字体

| 组件 | 许可证 |
|---|---|
| JetBrains Mono | SIL OFL 1.1（许可证文本见 `shell/public/fonts/OFL.txt`） |

## Rust 外壳（`shell/src-tauri`）

tauri · tauri-plugin-dialog · tauri-plugin-clipboard-manager（MIT / Apache-2.0）· serde · serde_json · trash · sha1 · base64 · portable-pty · notify-debouncer-mini · ignore · regex · shell-words · zip · sysinfo · rusqlite（MIT）

`rusqlite` 以 `bundled` 特性编译 SQLite C 源码——SQLite 属 **public domain**。

## 运行时智能（`intel/`）

tower-lsp · tokio · parking_lot · serde_json（均为 MIT 系）

## 随包分发、构建期拉取（不入库）

| 组件 | 许可证 | 说明 |
|---|---|---|
| **debugpy** | MIT（Microsoft） | 由 `tools/fetch-debugpy.ps1` 按 `ci/versions.toml` 的 sha256 拉取到 `vendor/debugpy/`，经 `tauri.conf.json` 的 `bundle.resources` 入包。**分发安装包时必须保留其许可声明** |

## 运行时调用的外部工具（不随包分发，由用户环境或首次启动引导安装）

uv（MIT）· pyrefly（MIT）· basedpyright（BSD-3-Clause）· ruff（MIT）· git（GPL-2.0，仅调用，不分发）

这些是独立可执行文件，Pylume 只调用其命令行接口，不构成衍生作品。

## 运行时平台依赖

Windows 安装包依赖 WebView2 Runtime 与 NSIS（运行时环境，非分发组件）。

---

完整的依赖版本锁定见 [`ci/versions.toml`](ci/versions.toml)；各 crate 的传递依赖清单见 `shell/src-tauri/Cargo.lock` 与 `intel/Cargo.lock`。

如发现本文件与实际不符，请提 issue——许可证遗漏是要认真对待的事。
