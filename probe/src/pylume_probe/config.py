"""配置加载：默认值 ← ~/.pylume/config/probe.json ← 环境变量/CLI 覆盖。

环境变量：
- PYLUME_PROBE_HOME   重定向 ~/.pylume（测试用）
- PYLUME_PROBE_CONFIG 指定配置文件路径
- PYLUME_PROBE_QUIET  =1 时抑制摘要输出
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProbeConfig:
    """探针配置（全部有默认值，零配置可用）。"""

    # 类型紧凑表示（P2-T03）
    max_container_depth: int = 2   # 容器嵌套深度上限
    max_union_types: int = 3       # 容器元素类型联合上限（超出截断为 |...）
    sample_elems: int = 8          # 容器元素采样个数上限
    # 采样限流（P2-T04）
    max_calls_per_func: int = 200  # 每函数记录调用数上限（超限静音，高频降采样）
    max_call_depth: int = 64       # 调用栈深度上限（更深只计 hits 不记参数观测；0 = 不限）
    max_type_obs_per_site: int = 100  # 每参数位/返回位类型观测上限（类型分布采样）
    # 模块白/黑名单：相对项目根的 POSIX 风格 glob（"tests" ≙ "tests/*"，* 跨目录）；
    # 白名单非空时仅采集匹配路径，黑名单优先于白名单
    include_modules: list[str] | None = None
    exclude_modules: list[str] | None = None
    # 存储
    db_dir: str | None = None      # None → <probe_home>/traces
    quiet: bool = False            # 抑制摘要输出


def probe_home() -> Path:
    """Pylume 用户目录（可用 PYLUME_PROBE_HOME 重定向，测试隔离用）。"""
    env = os.environ.get("PYLUME_PROBE_HOME")
    if env:
        return Path(env)
    return Path.home() / ".pylume"


def config_path() -> Path:
    env = os.environ.get("PYLUME_PROBE_CONFIG")
    if env:
        return Path(env)
    return probe_home() / "config" / "probe.json"


def load_config(**overrides) -> ProbeConfig:
    """加载配置：默认值 ← 配置文件 ← 环境变量 ← 显式覆盖（None 值忽略）。"""
    cfg = ProbeConfig()
    path = config_path()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"[pylume-probe] ⚠ 配置文件解析失败，使用默认值（{path}: {e}）",
                  file=__import__("sys").stderr)
        else:
            if isinstance(data, dict):
                for key, val in data.items():
                    if not key.startswith("_") and hasattr(cfg, key):
                        setattr(cfg, key, val)
    if os.environ.get("PYLUME_PROBE_QUIET") == "1":
        cfg.quiet = True
    for key, val in overrides.items():
        if val is not None and hasattr(cfg, key):
            setattr(cfg, key, val)
    return cfg
