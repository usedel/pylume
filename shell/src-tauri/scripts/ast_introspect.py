# pylume 受控脚本 · ast_introspect（内省，默认关）
# 职责：**执行用户脚本顶层代码**（副作用！前端必须先 openConfirm 确认，§11.5）后
# 从运行时对象读取参数默认值：argparse.ArgumentParser 实例（_actions）与
# click 命令对象（params，typer 构建后同为 click 形态）。
# 约束：R-7 —— `-I` 隐含 `-P`，cwd 不在 sys.path，**须显式 sys.path.insert**；
# 只读（不写文件、无网络）、独立子进程 5s 超时（Rust 侧 eval_timeout 映射）。
# 入参 stdin JSON：{path: <脚本绝对路径>}；输出与 ast_argparse 同形（{params: [...]}）。

import argparse
import json
import os
import sys

sys.path.insert(0, os.getcwd())  # R-7：-I 隐含 -P，不补则用户模块不可导入

MAX_PARAMS = 200


def _safe(v):
    """任意运行时值 → JSON 可序列化（失败退化为 str）。"""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [_safe(x) for x in v][:50]
    try:
        json.dumps(v)
        return v
    except (TypeError, ValueError):
        return str(v)[:120]


def _argparse_type(action):
    if action.nargs == 0 or getattr(action, "const", None) is True:
        return "bool"
    t = getattr(action, "type", None)
    if t is None:
        return "str"
    name = getattr(t, "__name__", None) or str(t)
    return name if name in ("str", "int", "float") else "str"


def params_from_argparse(parser, out):
    for a in getattr(parser, "_actions", []):
        if getattr(a, "dest", "") == "help":
            continue
        opts = list(getattr(a, "option_strings", []))
        out.append({
            "name": a.dest,
            "flag": opts[0] if opts else None,
            "type": _argparse_type(a),
            "default": _safe(getattr(a, "default", None)),
            "required": bool(getattr(a, "required", False)),
            "help": getattr(a, "help", None),
            "choices": list(a.choices) if getattr(a, "choices", None) else None,
            "source": "argparse",
        })


def _click_type(p):
    t = getattr(p, "type", None)
    name = getattr(t, "name", "")
    if name == "boolean" or getattr(p, "is_flag", False):
        return "bool"
    if name in ("int", "integer"):
        return "int"
    if name in ("float",):
        return "float"
    return "str"


def params_from_click(cmd, out):
    for p in getattr(cmd, "params", []):
        opts = list(getattr(p, "opts", []) or [])
        choices = getattr(getattr(p, "type", None), "choices", None)
        out.append({
            "name": getattr(p, "name", ""),
            "flag": opts[0] if opts else None,
            "type": _click_type(p),
            "default": _safe(getattr(p, "default", None)),
            "required": bool(getattr(p, "required", False)),
            "help": getattr(p, "help", None),
            "choices": list(choices) if choices else None,
            "source": "click",
        })


def collect(module):
    out = []
    # 浅扫模块命名空间：argparse 解析器实例 + click 命令对象
    for v in list(vars(module).values()):
        if isinstance(v, argparse.ArgumentParser):
            params_from_argparse(v, out)
        elif hasattr(v, "params") and isinstance(getattr(v, "params", None), list):
            # click 命令 / Group（typer 构建产物同为 click 形态）
            params_from_click(v, out)
        if len(out) >= MAX_PARAMS:
            break
    return out[:MAX_PARAMS]


def run(args):
    path = args.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError("path 必须是脚本路径字符串")
    if not os.path.isfile(path):
        raise ValueError("脚本不存在：%s" % path)
    import importlib.util
    name = "_pylume_introspect_%d" % os.getpid()
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("无法加载脚本模块")
    module = importlib.util.module_from_spec(spec)
    # ⚠ 此处执行用户脚本顶层代码（副作用）——前端已 openConfirm 确认
    spec.loader.exec_module(module)
    return {"params": collect(module)}


def main():
    try:
        args = json.loads(sys.stdin.read() or "{}")
        out = {"ok": True, "data": run(args)}
    except SystemExit as e:
        # 用户脚本顶层 sys.exit()：视作内省失败，透传退出码
        out = {"ok": False, "error": "SystemExit: %s（脚本顶层调用了 sys.exit）" % (e.code if e.code is not None else 0)}
    except Exception as e:  # noqa: BLE001 —— 受控脚本兜底协议出口
        out = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


main()
