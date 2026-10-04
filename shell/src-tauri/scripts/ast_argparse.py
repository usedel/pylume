# pylume 受控脚本 · ast_argparse
# 职责：用 ast 静态解析脚本内 argparse add_argument / click.option / typer.Option 的
# **字面量参数**，产出参数表单模型（{name, flag, type, default, help, required, choices}）。
# 约束：**不 import 用户模块、不执行用户代码**（PR-4 内省 kind 才执行，独立开关）；
# 只读、无网络、stdin 进 JSON（{code: <脚本源码>}）、stdout 出单行 JSON。
# 由 Rust 侧以 `python -I -X utf8 -c <本文件> <kind>` 启动。

import ast
import json
import sys


def _const(node):
    """提取字面量常量（含 list/tuple 展开）；非常量返回 None（无法静态确定）。"""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple)):
        vals = [_const(e) for e in node.elts]
        return vals if all(v is not None for v in vals) else None
    return None


def _type_name(node):
    """类型注解的表达式名：int / float / str / bool / click.INT 等（取最右侧名）。"""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Call):
        return _type_name(node.func)
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _kwargs(call):
    out = {}
    for kw in call.keywords:
        if kw.arg is None:  # **expanded 展开——静态无法确定，跳过
            continue
        out[kw.arg] = (kw.value, _const(kw.value), _type_name(kw.value))
    return out


def _pos_strs(call):
    return [a.value for a in call.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]


def _param(name, flag, kw, source):
    _, default, _ = kw.get("default", (None, None, None))
    _, required, _ = kw.get("required", (None, None, None))
    _, help_, _ = kw.get("help", (None, None, None))
    _, choices, _ = kw.get("choices", (None, None, None))
    _, type_, tyname = kw.get("type", (None, None, None))
    _, action, _ = kw.get("action", (None, None, None))
    _, is_flag, _ = kw.get("is_flag", (None, None, None))
    _, nargs, _ = kw.get("nargs", (None, None, None))
    # action="store_true"/"store_false" 或 is_flag=True → bool 开关
    ptype = "bool" if (action in ("store_true", "store_false") or is_flag is True) else (tyname or "str")
    # nargs 只认字面量（"*" / "+" / "?" / 整数）；非常量（变量 / 表达式）一律 None
    nargs_val = nargs if isinstance(nargs, (str, int)) and not isinstance(nargs, bool) else None
    return {
        "name": name,
        "flag": flag,
        "type": ptype,
        "default": default,
        "required": required,
        "help": help_,
        "choices": choices,
        "nargs": nargs_val,
        "source": source,
    }


def scan(code):
    tree = ast.parse(code)
    params = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attr = node.func.attr
            if attr == "add_argument":
                # argparse：parser.add_argument("name" | "-v" | "--verbose", type=int, ...)
                names = _pos_strs(node)
                if not names:
                    continue
                flags = [n for n in names if n.startswith("-")]
                plain = [n for n in names if not n.startswith("-")]
                if plain:
                    name, flag = plain[0], flags[0] if flags else "--" + plain[0]
                elif flags:
                    name, flag = flags[-1].lstrip("-").replace("-", "_"), flags[-1]
                else:
                    continue
                params.append(_param(name, flag, _kwargs(node), "argparse"))
            elif attr == "option" and _pos_strs(node):
                # click：@click.option("--name", type=..., ...)
                flag = _pos_strs(node)[0]
                if not flag.startswith("-"):
                    continue
                name = flag.lstrip("-").replace("-", "_")
                params.append(_param(name, flag, _kwargs(node), "click"))
            elif attr == "argument" and _pos_strs(node):
                # click：@click.argument("name", type=...)
                name = _pos_strs(node)[0]
                params.append(_param(name, None, _kwargs(node), "click"))
    # typer：`x: int = typer.Option(default=..., ...)`（函数默认值赋值形态）
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
            continue
        fn = node.value.func
        if not (isinstance(fn, ast.Attribute) and fn.attr == "Option"):
            continue
        names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if not names:
            continue
        # typer.Option 的位置参数：第一个位置常量是默认值（typer 风格 default 在首位）
        pos = [ _const(a) for a in node.value.args ]
        kw = _kwargs(node)
        if "default" not in kw and pos and pos[0] is not None:
            node.value.keywords.append(ast.keyword(arg="default", value=ast.Constant(value=pos[0])))
            kw["default"] = (ast.Constant(value=pos[0]), pos[0], None)
        params.append(_param(names[0], "--" + names[0].replace("_", "-"), kw, "typer"))
    return params


def run(args):
    code = args.get("code")
    if not isinstance(code, str):
        raise ValueError("code 必须是字符串")
    return {"params": scan(code)}


def main():
    try:
        args = json.loads(sys.stdin.read() or "{}")
        out = {"ok": True, "data": run(args)}
    except SyntaxError as e:
        out = {"ok": False, "error": "SyntaxError: %s" % e}
    except Exception as e:  # noqa: BLE001 —— 受控脚本的兜底协议出口
        out = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


main()
