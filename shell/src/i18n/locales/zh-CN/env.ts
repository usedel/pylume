// 简体中文语言包「env 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/env_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const env = {
  // ---- env.action ----
  "env.action.browseInterpreter": "浏览解释器…",
  "env.action.createVenvBtn": "创建 .venv",
  "env.action.createVenvMenu": "创建 .venv…",
  "env.action.declare": "加入 pyproject",
  "env.action.install": "安装",
  "env.action.installNow": "立即安装",
  "env.action.later": "稍后",
  "env.action.rebuild": "重建",
  "env.action.rebuildVenv": "重建 .venv…",
  "env.action.uninstall": "卸载",
  "env.action.upgrade": "升级",
  // ---- env ----
  "env.autoInstallNoInterpreter": "尚未选择解释器，无法自动安装包（点状态栏解释器图标选择后再试）",
  "env.bootstrapAsk": "是否现在安装？",
  "env.bootstrapBullet": "· {tool}",
  "env.bootstrapEcho": "> 工具链引导：安装 {tools}",
  "env.bootstrapMissing": "检测到缺少以下工具：",
  "env.bootstrapOk": "工具链就绪。",
  "env.bootstrapPartial": "安装结束，但部分工具仍不可见，请重启 Pylume 后再试。",
  "env.bootstrapWhy": "补全、跳转与运行都需要它们。可一键下载安装到用户目录（不影响系统，需联网）。",
  // ---- env.confirm ----
  "env.confirm.cancel": "取消",
  // ---- env ----
  "env.createFailed": "创建环境失败：{error}",
  "env.created": "已创建 .venv 并设为当前解释器",
  // ---- env.dialog ----
  "env.dialog.bootstrapTitle": "环境引导",
  "env.dialog.pickTitle": "选择 Python 解释器",
  "env.dialog.pythonFilter": "Python 解释器",
  "env.dialog.rebuildTitle": "重建 .venv",
  "env.dialog.uninstallTitle": "卸载包",
  "env.dialog.upgradeTitle": "升级包",
  // ---- env.empty ----
  "env.empty.noEnv": "未检测到 Python 环境——补全、跳转、运行与依赖管理都依赖环境（当前以 uv run 兜底，能力受限）。",
  // ---- env.fail ----
  "env.fail.install": "安装包",
  "env.fail.pick": "选择解释器",
  "env.fail.refreshDiagnostics": "刷新诊断",
  "env.fail.setInterpreter": "设置解释器",
  // ---- env.group ----
  "env.group.systemUv": "系统 / uv",
  "env.group.workspace": "工作区",
  // ---- env ----
  "env.installCanceled": "已取消安装 {module}",
  "env.installConfirm": "是否继续？",
  "env.installExitFailed": "安装失败（exit {code}），详见上方输出",
  "env.installFailed": "安装失败：{error}",
  "env.installIntoPrefix": "将安装 \"{module}\" 到当前解释器：",
  "env.installed": "已安装 {spec}",
  "env.installedDiagnostics": "已安装 {module}（诊断刷新中…）",
  // ---- env.interp ----
  "env.interp.defaultUvRun": "（默认）uv run",
  "env.interp.label": "{name} {hint}",
  "env.interp.notSetHint": "未指定解释器——运行时以 uv run 兜底",
  "env.interp.unspecified": "未指定解释器",
  // ---- env ----
  "env.invalidInterpreter": "\"{name}\" 无法读取版本，可能不是有效的 Python 解释器",
  // ---- env.kind ----
  "env.kind.manualPlain": "手动",
  "env.kind.manualVenv": "手动{ver}",
  "env.kind.workspaceVenv": "工作区 .venv{ver}",
  // ---- env ----
  "env.noEnvToast": "未检测到 Python 环境，补全 / 运行 / 依赖管理受限",
  "env.noInterpreter": "尚未选择解释器——请先在上方「环境」下拉中选择",
  // ---- env.pkg ----
  "env.pkg.uninstallTip": "卸载 {name}",
  "env.pkg.upgradeAria": "升级 {name} 到 {to}",
  "env.pkg.upgradeTip": "升级 {name}：{from} → {to}",
  // ---- env.pkgs ----
  "env.pkgs.loading": "正在加载已安装包…",
  "env.pkgs.noMatch": "没有匹配的包",
  "env.pkgs.none": "（无已安装包）",
  "env.pkgs.pickFirst": "选择解释器后查看已安装包",
  "env.pkgs.selectToUninstall": "选择以卸载",
  // ---- env ----
  "env.rebuildConfirm": "确认重建？",
  "env.rebuildExists": "当前 .venv 已存在{note}。",
  "env.rebuildHint": "将清空现有 .venv{note}并重建",
  // ---- env.rebuildPkgNote ----
  "env.rebuildPkgNote.one": "，含 {count} 个已安装包",
  "env.rebuildPkgNote.other": "，含 {count} 个已安装包",
  // ---- env.rebuildPkgNoteParen ----
  "env.rebuildPkgNoteParen.one": "（含 {count} 个已安装包）",
  "env.rebuildPkgNoteParen.other": "（含 {count} 个已安装包）",
  // ---- env ----
  "env.rebuildWarn": "重建会清空现有环境、新建空环境，已装包需重新安装（uv venv 对已存在环境默认删除重建）。",
  // ---- env.state ----
  "env.state.creating": "创建中…",
  "env.state.installing": "安装中…",
  "env.state.uninstalling": "卸载中…",
  "env.state.upgrading": "升级中…",
  // ---- env ----
  "env.switched": "已切换解释器：{name} {ver}",
  // ---- env.tag ----
  "env.tag.driftTip": "已安装但未写入 pyproject 声明（E3 漂移）——依赖健康区可一键写入",
  "env.tag.installed": "已安装",
  "env.tag.needDownload": "需下载",
  "env.tag.notDeclared": "未声明",
  // ---- env.tool ----
  "env.tool.engine": "{name}（补全 / 跳转）",
  "env.tool.uv": "uv（Python 环境与运行）",
  // ---- env ----
  "env.uninstallFailed": "卸载失败：{error}",
  // ---- env.uninstallMsg ----
  "env.uninstallMsg.one": "卸载 {count} 个包：{names}？",
  "env.uninstallMsg.other": "卸载 {count} 个包：{names}？",
  // ---- env.uninstalled ----
  "env.uninstalled.one": "已卸载 {count} 个包",
  "env.uninstalled.other": "已卸载 {count} 个包",
  // ---- env ----
  "env.upgradeExitFailed": "升级失败（exit {code}），详见上方输出",
  "env.upgradeFailed": "升级失败：{error}",
  // ---- env.upgradeMsg ----
  "env.upgradeMsg.one": "升级 {count} 个过时包？",
  "env.upgradeMsg.other": "升级 {count} 个过时包？",
  // ---- env.upgraded ----
  "env.upgraded.one": "已升级 {count} 个包",
  "env.upgraded.other": "已升级 {count} 个包",
  // ---- env ----
  "env.venvDetected": "检测到工作区 .venv，是否设为当前解释器？",
  // ---- env.versions ----
  "env.versions.downloadHint": "若该 Python 版本尚未安装，uv 将联网下载（数十 MB，慢网可能数分钟），进度见下方…",
  "env.versions.none": "未检测到可用 Python 版本（请确认 uv 已安装）",
};

/** 本域文案 key：en-US/env.ts 的 Record<EnvKey, string> 由它派生。 */
export type EnvKey = keyof typeof env;
