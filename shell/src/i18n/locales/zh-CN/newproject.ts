// 简体中文语言包「newproject 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/newproject_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const newproject = {
  // ---- newproject ----
  "newproject.tabLocal": "本地创建",
  "newproject.createFailed": "创建失败：{error}",
  "newproject.creating": "创建中…",
  "newproject.creatingEnv": "创建环境…",
  "newproject.depsExitFailed": "依赖安装失败（exit {code}），详见上方输出；声明已写入 pyproject.toml，可稍后运行项目由 uv 自动同步",
  "newproject.depsExitNote": "exit {code}（声明已写入，不阻断）",
  "newproject.depsFailedNonBlocking": "依赖安装失败（声明已写入 pyproject.toml，不阻断）：{error}，可稍后运行项目由 uv 自动同步",
  "newproject.envSetupFailed": "环境配置失败：{error}",
  "newproject.failDeps": "依赖安装",
  "newproject.failEnvSetup": "环境配置",
  "newproject.gitInitFailed": "git init 失败（项目已创建）：{message}",
  "newproject.gotIt": "知道了",
  "newproject.installingDeps": "安装依赖…",
  "newproject.loadingVersions": "加载版本列表中…",
  "newproject.needNameAndPath": "请填写项目名称和位置",
  "newproject.noInterpFallback": "在完成前将使用 uv run 兜底运行（首次运行可能联网下载 Python）。",
  "newproject.noInterpHead": "可任选其一：",
  "newproject.noInterpStep1": "1) 用 uv 安装托管 Python（环境面板或终端执行：uv python install 3.13）",
  "newproject.noInterpStep2": "2) 手动指定已安装的 python 可执行文件路径（环境面板 → 解释器）",
  "newproject.noInterpTitle": "未检测到 Python 解释器",
  "newproject.previewPath": "将创建于：{target}{suffix}",
  "newproject.previewSuffix": "（{label} 入口 main.py + {deps} 依赖）",
  "newproject.systemInterpreter": "已选用系统解释器：{interp}",
  // ---- newproject.type ----
  "newproject.type.fastapi": "FastAPI 服务",
  "newproject.type.script": "Python 脚本",
  // ---- newproject.versions ----
  "newproject.versions.default": "（默认版本）",
  "newproject.versions.needDownload": "{version}（需下载）",
};

/** 本域文案 key：en-US/newproject.ts 的 Record<NewprojectKey, string> 由它派生。 */
export type NewprojectKey = keyof typeof newproject;
