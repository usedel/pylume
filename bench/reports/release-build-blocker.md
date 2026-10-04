# Release 出包阻塞：`tauri build` 在本机稳定链接失败

> 记录时间：2026-10-03 · 状态：**已解决（2026-10-03 19:40 出包成功）**
> 首次发现：2026-10-03 执行 `docs/debug_acceptance_record.md` §五 第 8 项「真安装包验收」时
> 结论简介：走「方案 A + 进程级环境装配」——装 VS2022 Build Tools（落地 `D:\VSBuildTools`），
> 并由新增的 `tools/msvc-env.ps1` 在 `build-release.ps1` 里前置 link.exe / LIB / INCLUDE。
> 本机专属的 `shell/.cargo/config.toml` 硬编码 hack **已删除**，不再需要。
> 产物：`shell/src-tauri/target/release/bundle/nsis/Pylume_0.1.0_x64-setup.exe`

## 现象

`powershell -File build-release.ps1 -SkipNpmInstall` 在最后一步 `npm run tauri -- build` 稳定失败：

```
error: linking with `link.exe` failed: exit code: 1120
  liblibsqlite3_sys-...rlib(sqlite3.o) : error LNK2019: unresolved external symbol __imp_memchr   referenced in function jsonLookupStep
  liblibsqlite3_sys-...rlib(sqlite3.o) : error LNK2019: unresolved external symbol __imp_strchr   referenced in function jsonbValidityCheck
  liblibsqlite3_sys-...rlib(sqlite3.o) : error LNK2019: unresolved external symbol __imp_strrchr referenced in function sqlite3ShadowTableName
  pylume_shell_lib.dll : fatal error LNK1120: 3 unresolved externals
error: could not compile `pylume-shell` (lib) due to 1 previous error
```

三个未解析符号全部来自 **UCRT**（`__imp_` 前缀 = dllimport 形式），全部指向 `libsqlite3-sys` 的 `sqlite3.o`（bundled SQLite C 源码，`rusqlite = { features = ["bundled"] }`，`shell/src-tauri/Cargo.toml:34`）。

## 根因（已定位到具体机制）

链接命令要求 `/DEFAULTLIB:ucrt.lib`，但**本机 PATH 里的 MSVC 工具链是 Visual Studio 14.0（VS2015 RTM），其 `VC\lib` 目录只有 `libcmt.lib` / `libvcruntime.lib`，没有 `ucrt.lib`**——UCRT 自 VS2015 后期起改为随 **Windows SDK** 分发。

关键事实（均可复现）：

| 事实 | 证据 |
|---|---|
| PATH 里的 link.exe 是 VS2015 | `where link` → `C:\Program Files (x86)\Microsoft Visual Studio 14.0\VC\bin\link.exe` |
| VS2015 的 lib 目录无 ucrt.lib | 该目录 CRT 库实测只有 `libcmt.lib` `libcmt.pdb` `libcmtd.lib` `libvcruntime.lib` `vcruntime.lib` 等 |
| 本机无 VS2019/2022 / Build Tools | `C:\Program Files (x86)\Microsoft Visual Studio` 下无 2019/2022 子目录；`C:\Program Files\Microsoft Visual Studio` 不存在 |
| Windows SDK 存在且有 ucrt.lib | `C:\Program Files (x86)\Windows Kits\10\Lib\10.0.10240.0\ucrt\x64\ucrt.lib`（仅此一个版本） |
| **手动 cargo 能过** | `cargo build --release`（3m18s）与 `cargo build --release -p pylume-shell`（2m53s）**均成功** |
| **tauri build 必失败** | 同机同代码，`npx tauri build` 稳定复现上述错误 |

差异在链接命令的 `/LIBPATH` 列表：
- 手动 cargo：rustc 自行探测到 MSVC + Windows SDK，把相应 lib 目录加进 `/LIBPATH`；
- tauri build：`/LIBPATH` 里**只有 cargo 的 out 目录和 rust 自带的 msvc lib**，既无 VS2015 的 lib 也无 SDK 的 ucrt —— tauri CLI spawn cargo 时用自己的 MSVC 探测**覆盖**了 rustc 的探测结果。

## 已尝试且无效的修法（不要重复踩）

| # | 做法 | 结果 |
|---|---|---|
| 1 | 在 `build-release.ps1` 里把 SDK `ucrt\x64` 前置到 `$env:LIBPATH` | ❌ tauri 覆盖；且 MSVC `link.exe` 读的是 `LIB` 而非 `LIBPATH` |
| 2 | 设 `LIB=<SDK>\ucrt\x64` 环境变量 | ❌ `/LIBPATH` 列表无变化，仍失败 |
| 3 | 设 `WindowsSdkDir` + `WindowsSDKVersion` 环境变量 | ❌ 仍失败 |
| 4 | 设 `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS=-C target-feature=+crt-static` | ❌ 链接命令完全没变（tauri 覆盖 / 未触发重编） |

> 上述 4 项均已回滚或未落盘，`build-release.ps1` 保持 HEAD 原状（`git diff` 为空）。

## 附带发现：静默安装也无效

`Pylume_0.1.0_x64-setup.exe /S`（Tauri NSIS，`installMode: currentUser`）在本机**静默安装无效**：

- 退出码 `0`，但 `%LOCALAPPDATA%\Pylume` 无任何 exe 落地（目录 mtime 仍为 2026-09-22，只有 `extensions/` 与 `webview/`）；
- 注册表 `HKCU\...\Uninstall\com.pylume.shell` 不存在；
- 即"安装成功"是假阳性，不能用它做自动化验收。

因此 §五 第 8 项「真安装包验收」**无法用现成安装包闭环**。

## 补充（2026-10-03 晚）：装 VS2022 时踩到的第二个坑 —— 安装器 5002

方案 A（装 VS2022 Build Tools）本身也会失败，且**与磁盘/权限无关**：

- `winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --installPath ..."` → `exit 5002`；
- 直接用 bootstrapper `vs_BuildTools.exe --wait --passive ...` → 同样 `5002`，且秒退。

真因在 `%TEMP%\dd_bootstrapper_*.log`：

```
Error 0x80070057: Couldn't launch setup process. Error: 已添加项。
字典中的关键字:"HTTP_PROXY" 所添加的关键字:"http_proxy"
...
字典中的关键字:"PATH" 所添加的关键字:"Path"
```

VS 安装器用 `StringDictionaryWithComparer`（**大小写不敏感**）复制当前进程环境来启动 `setup.exe`；
只要环境里存在同一变量的两种大小写写法（`HTTP_PROXY`/`http_proxy`、`PATH`/`Path`），
`Add` 就抛"已添加项"，安装器连 `setup.exe` 都起不来。本机会话里恰好被注入了 3 组这样的重复键
（值完全相同），所以 winget 与 bootstrapper 两条路都死在同一处。

**修法**：启动安装器前把重复键去掉一组即可（两者值相同，删哪个都安全）：

```powershell
foreach ($n in 'PATH','HTTP_PROXY','HTTPS_PROXY') {
    $v = [Environment]::GetEnvironmentVariable($n, 'Process')
    [Environment]::SetEnvironmentVariable($n, $null, 'Process')
    if (-not [Environment]::GetEnvironmentVariable($n,'Process')) {
        [Environment]::SetEnvironmentVariable($n, $v, 'Process')   # 回滚保护
    }
}
& D:\tmp\vs_BuildTools.exe --wait --passive --norestart --installPath D:\VSBuildTools `
    --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
```

> 注意：每组重复键要逐个清——第一次只清了 proxy，安装器随即报 `PATH`/`Path` 重复。

## 候选修法（需决策）

| # | 方案 | 代价 | 风险 / 说明 |
|---|---|---|---|
| **A** | 安装 Visual Studio Build Tools 2019/2022 + Windows SDK | 下载数 GB，十几分钟 | **治本**。新版 MSVC 自带 ucrt.lib，且 tauri 的探测能找到它。之后 `build-release.ps1` 恢复原样即可 |
| **B** | 把 SDK 的 `ucrt.lib` 复制进 VS2015 的 `VC\lib` | 5 秒，可逆（删掉即恢复） | 立即生效。风险：SDK 10.0.10240.0 是 Win10 1507 初始版 UCRT，与 VS2015 的 `libcmt.lib` 混用有**运行时 ABI 风险**；且需要 `um\x64` 里的 `kernel32.lib` 等配套库，本机 SDK 可能不完整 |
| **C** | 提交 `shell/.cargo/config.toml`：`[target.x86_64-pc-windows-msvc] rustflags = ["-C", "link-arg=/LIBPATH:<SDK>/ucrt/x64"]` | 触发全量重编（10~20 分钟，一次性） | cargo 自己读 config，tauri 覆盖不了。缺点：路径硬编码进仓库（可脚本生成 + gitignore）；`link-arg` 方案对其它机器不可移植 |
| **D** | 改 `build-release.ps1`：`npm run build` → 手动 `cargo build --release`（带 tauri 所需 env）→ 只调 tauri 的 bundler | 中等，需摸清 tauri 注入的 env | 绕过 tauri 的环境覆盖，保留官方 bundler。但 tauri 的 `TAURI_ENV_*` 变量较多，摸清有维护成本，且未来升级易回归 |

**倾向**：先 A（治本、可复现、后续所有出包都受益）；若因下载体积/网络不便接受，用 C 作为本机可复现的备选。**不建议 B**（ABI 风险不可控）。

## 最终采用（已闭环）

1. **装 VS2022 Build Tools** 到 `D:\VSBuildTools`（工作负载 `Microsoft.VisualStudio.Workload.VCTools`
   + `--includeRecommended`，自带 MSVC 14.44.35207 与 Windows SDK 10.0.26100.0）。
   踩坑与绕法见上文「安装器 5002」一节。
2. **新增 `tools/msvc-env.ps1`**，被 `build-release.ps1` dot-source 后调用 `Import-MsvcEnv`：
   vswhere 定位 VS → 前置 `link.exe` 到 PATH；把 SDK 的 `ucrt\x64` + `um\x64` 导入库 robocopy 到
   无空格暂存目录 → 写入 `LIB`/`INCLUDE`。
3. **删除 `shell/.cargo/config.toml`**（本机硬编码 linker + `+crt-static` 的那套），
   并在 `.gitignore` 里加 `shell/.cargo/` 防止再被生成物误提交。
   现方案只改**进程**环境，不动系统 PATH/注册表，也不要求 `-C target-feature=+crt-static`，
   因此不需要那次 10~20 分钟的全量重编。
4. **修 `build-release.ps1` 的误判**：`$ErrorActionPreference="Stop"` 下，cargo/npm 写到 stderr 的
   正常进度行会被当成终止错误（脚本 5 秒就假失败）。新增 `Invoke-Native` 统一处理。

验证：`powershell -File .\build-release.ps1 -SkipNpmInstall` 全绿，
`Finished 1 bundle at: .../bundle/nsis/Pylume_0.1.0_x64-setup.exe`（19:40，8.7 MB）。

## 修复后的验收方式

出包成功后，`shell/e2e-real/release-real.cjs`（本轮新增）可直接验证"安装后能否真正干活"：release exe 启动、LSP 就绪、debugpy 随包可用、运行脚本输出正确、停止后进程树无残留。

> 注意：release exe **必须**由 `tauri build` 产出。手动 `cargo build --release` 虽然链接成功，但因缺少 tauri 注入的环境变量，前端不会嵌入（`frontendDist` 失效），运行时会回退去连 `devUrl` `http://localhost:5173` → `ERR_CONNECTION_REFUSED`。此现象已实测确认，不要误判为"exe 损坏"。
