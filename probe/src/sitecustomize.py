"""sitecustomize 注入入口（顶层模块，经 PYTHONPATH 生效）。

仅当 PYLUME_PROBE_AUTOSTART=1 时激活；否则零动作。
注意：PYTHONPATH 注入会遮蔽目标 venv 自身的 sitecustomize（显式运行场景可接受）。
"""
import os
import sys

if os.environ.get("PYLUME_PROBE_AUTOSTART") == "1":
    try:
        from pylume_probe.autostart import bootstrap
        bootstrap()
    except Exception as e:  # noqa: BLE001 - 探针失败绝不拖垮用户脚本
        print(f"[pylume-probe] ⚠ 注入失败（忽略，继续正常运行）：{e}", file=sys.stderr)
