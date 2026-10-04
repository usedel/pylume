"""类型紧凑表示（P2-T03）。

原则：
- 实例 → 「模块+类名」（builtins/__main__ 前缀省略）；
- 容器 → 结构指纹（dict[K, V] / list[T]），深度受限（默认 2 层），元素类型采样联合；
- 绝不 repr 值本身，避免大对象开销与内存膨胀；
- shape_fingerprint 额外提取结构指纹：全 str 键小 dict 的键集合 / 实例属性名集合；
- **聚合键顺序必须稳定**（P1-15，2026-09-29 review）：同一观测位跨运行/跨进程必须
  产出相同字符串。set/frozenset 迭代序受 PYTHONHASHSEED 影响是进程级随机源——其
  类型联合 parts 排序；shape_fingerprint 的 merged 结构序列化补 sort_keys=True。
  dict 分支的 kparts/vparts **保留插入序不排序**：插入序跨进程稳定，且已存 trace 库
  的历史观测字符串（如 `dict[str, str|list[str]]`）按此格式沉淀，改排序会与历史
  分裂（test_check 用例锁定的正是这一点）。
"""
from __future__ import annotations

import json
import types

_SCALARS = frozenset({int, float, str, bytes, complex})  # bool 单列（bool 是 int 子类）
_CONTAINERS = {list: "list", tuple: "tuple", set: "set", frozenset: "frozenset"}
_FUNC_TYPES = (
    types.FunctionType,
    types.BuiltinFunctionType,
    types.MethodType,
    types.WrapperDescriptorType,
    types.MethodWrapperType,
    types.MethodDescriptorType,
    types.ClassMethodDescriptorType,
)


def type_label(t: type) -> str:
    """类型的「模块+类名」表示；builtins / __main__ 前缀省略。"""
    mod = getattr(t, "__module__", None)
    name = getattr(t, "__qualname__", None) or getattr(t, "__name__", "?")
    if mod in (None, "builtins", "__main__"):
        return name
    # 私有实现模块段归一化（如 pathlib._local.Path → pathlib.Path）
    parts = mod.split(".")
    while len(parts) > 1 and parts[-1].startswith("_") and parts[-1] != "_":
        parts.pop()
    return f"{'.'.join(parts)}.{name}"


def compact_type(value, max_depth: int = 2, max_union: int = 3, sample: int = 8) -> str:
    """值的紧凑类型字符串。

    P2-5（2026-09-29 review）：顶层异常兜底——用户 metaclass 可在 `__module__` /
    `__qualname__` / `__name__` / `len()` / 迭代上定义 property/`__getattr__` 魔法，
    执行任意代码或抛异常。sys.monitoring 回调抛异常会按 unraisable 处理并可能令
    回调被禁用（探针静默失效，违反「探针失败只打警告」）。shape_fingerprint 自带
    兜底（返回 None），此处对齐：任何异常降级为 "?"（观测近似值，探针存活优先）。
    """
    try:
        return _compact(value, 0, max_depth, max_union, sample)
    except Exception:  # noqa: BLE001 - 恶意/魔法对象的降级路径
        return "?"


def _compact(v, depth: int, max_depth: int, max_union: int, sample: int) -> str:
    if v is None:
        return "None"
    t = type(v)
    if t is bool:
        return "bool"
    if t in _SCALARS:
        return t.__name__
    if isinstance(v, types.ModuleType):
        return "module"
    if isinstance(v, type):
        return f"type[{type_label(v)}]"
    cname = _CONTAINERS.get(t)
    if cname is not None:
        if depth >= max_depth:
            return f"{cname}[...]"
        n = len(v)
        if n == 0:
            return cname
        parts: list[str] = []
        scanned = 0
        for item in v:
            if scanned >= sample or len(parts) >= max_union:
                break
            scanned += 1
            s = _compact(item, depth + 1, max_depth, max_union, sample)
            if s not in parts:
                parts.append(s)
        # P1-15：set/frozenset 迭代序受 PYTHONHASHSEED 影响（进程级随机）——仅这两个
        # 分支排序；list/tuple 保留插入序（跨进程稳定，且与已存 trace 库的历史观测
        # 字符串兼容，排序反而会分裂）。
        if cname in ("set", "frozenset"):
            parts.sort()
        body = "|".join(parts)
        if scanned < n and len(parts) >= max_union:
            body += "|..."
        return f"{cname}[{body}]"
    if t is dict:
        if depth >= max_depth:
            return "dict[...]"
        n = len(v)
        if n == 0:
            return "dict"
        kparts: list[str] = []
        vparts: list[str] = []
        scanned = 0
        for k, val in v.items():
            if scanned >= sample or (len(kparts) >= max_union and len(vparts) >= max_union):
                break
            scanned += 1
            ks = _compact(k, depth + 1, max_depth, max_union, sample)
            if ks not in kparts:
                kparts.append(ks)
            vs = _compact(val, depth + 1, max_depth, max_union, sample)
            if vs not in vparts:
                vparts.append(vs)
        kbody = "|".join(kparts)
        vbody = "|".join(vparts)
        if scanned < n:
            if len(kparts) >= max_union:
                kbody += "|..."
            if len(vparts) >= max_union:
                vbody += "|..."
        return f"dict[{kbody}, {vbody}]"
    if isinstance(v, _FUNC_TYPES):
        return "Callable"
    # 普通实例：模块+类名（子类化的 list/dict 也走这里，保留精确类名）
    return type_label(t)


_MAX_SHAPE_DEPTH = 5    # shape 递归深度上限（与 intel MAX_CHAIN 对齐，性能上限）
_MAX_SHAPE_ELEMS = 64   # list/tuple 元素采样上限：大容器只扫前 N 个元素合并结构（键数另受 max_keys 限）


def shape_fingerprint(value, max_keys: int = 16) -> str | None:
    """结构指纹：dict / list-of-dict 按递归结构，普通实例按属性名数组。

    - dict（全 str 键小字典）→ JSON 对象，每键 → 值节点；
    - list/tuple（元素为 dict）→ {\"e\": 元素结构}（顶层 list 也记录，供 list 元素索引补全）；
    - 普通实例 → 属性名 JSON 数组（兼容 P2/P3 既有格式）。

    值节点：标量 → 类型标签字符串；dict → {\"t\":类型,\"k\":{子键→子节点}}；
    list-of-dict → {\"t\":类型,\"e\":元素结构}。递归深度 ≤ _MAX_SHAPE_DEPTH。
    """
    try:
        if isinstance(value, dict):
            if not value or len(value) > max_keys:
                return None
            if not all(isinstance(k, str) for k in value):
                return None
            obj = {k: _shape_value(v, max_keys, 0) for k, v in value.items()}
            return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        if isinstance(value, (list, tuple)):
            node = _elem_shape(value, max_keys, 0)
            if node is not None:
                # P1-15：补 sort_keys=True——merged 按元素键插入序构建，同构 list-of-dict
                # 因构造路径键序不同会分裂出不同指纹（对比上方 dict 分支已有 sort_keys）。
                return json.dumps({"e": node}, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            return None
        if isinstance(value, type):
            return None
        d = getattr(value, "__dict__", None)
        if isinstance(d, dict) and 0 < len(d) <= max_keys:
            return json.dumps(sorted(d), ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return None
    return None


def _shape_value(v, max_keys: int, depth: int):
    """值节点：标量 → 类型标签；dict → {\"t\",\"k\"}；list-of-dict → {\"t\",\"e\"}。"""
    if depth >= _MAX_SHAPE_DEPTH:
        return compact_type(v, max_depth=1)
    tv = compact_type(v, max_depth=1)
    if isinstance(v, dict):
        if not v or len(v) > max_keys or not all(isinstance(k, str) for k in v):
            return tv
        return {"t": tv, "k": {k: _shape_value(val, max_keys, depth + 1) for k, val in v.items()}}
    if isinstance(v, (list, tuple)):
        node = _elem_shape(v, max_keys, depth + 1)
        if node is not None:
            return {"t": tv, "e": node}
        return tv
    return tv


def _elem_shape(seq, max_keys: int, depth: int):
    """合并 list 元素的 dict 键结构（同构/异构都覆盖；每键取首个出现的值结构）。

    扫描元素数受 _MAX_SHAPE_ELEMS 上限约束：超大容器（如十万元素 list-of-dict）不
    会全量遍历，与 compact_type 的 sample 语义一致——部分键若只出现在未采样区间会
    被省略，这是有意的精度换性能取舍。
    """
    merged: dict = {}
    scanned = 0
    for item in seq:
        if not (isinstance(item, dict) and item and len(item) <= max_keys
                and all(isinstance(k, str) for k in item)):
            scanned += 1
            if scanned >= _MAX_SHAPE_ELEMS:
                break
            continue
        scanned += 1
        for k, v in item.items():
            if k not in merged:
                merged[k] = _shape_value(v, max_keys, depth)
        if len(merged) > max_keys:
            break
        if scanned >= _MAX_SHAPE_ELEMS:
            break
    if not merged:
        return None
    return {"t": compact_type(seq, max_depth=1), "k": merged}
