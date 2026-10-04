#!/usr/bin/env python3
"""UI token 审计 + WCAG 复算 + 门禁（`docs/ui_premium_dev_plan.md` §3.2 / §4）。

零第三方依赖（Python 3.13 标准库）——与 `probe/` 同一纪律。
本脚本是 `docs/ui_premium_design_report.md` §7「验收清单」里那批「可机检、不接受纯人工抽查」
门禁的落点：把报告里手算的对比度/色相数字固化成一键可重跑的判定。

用法：
    python tools/ui/audit_tokens.py                 # 人读报告（违规退出码 1）
    python tools/ui/audit_tokens.py --json          # 机器可读 JSON
    python tools/ui/audit_tokens.py --css <path>    # 指定 style.css（默认仓库内 shell/src/style.css）

已实现的门禁（批次推进时在 KNOWN_RESIDUALS 里登记"待后续批修"的残留面）：
  1. 单色相：brand/accent/link/focus-ring/brand-gradient 的色相与 --brand 基准相差 ≤ 15°
  2. accent 面门禁：--accent 作为文字色在各面上需 ≥4.5；不达标的面必须有 --accent-emphasis 且它达标
  3. 白字 on --accent-fill ≥ 4.5（--on-accent 13 处白字的合规前提）
  4. 浅色 --fg-dim 在各面 ≥ 4.5（杠杆 9）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# Windows CI 控制台可能是 cp1252，打印中文/特殊字符会 UnicodeEncodeError —— 强制 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------- 常量

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CSS = REPO_ROOT / "shell" / "src" / "style.css"

AA_TEXT = 4.5          # WCAG 2.1 AA 正文阈值
HUE_TOLERANCE = 15.0   # 单色相轴容差（度）

# 「面」= 文字可能落上去的背景。新阶梯（--surface-0..4，批 2a 起）优先；
# 批 1 尚无 --surface-*，回落到旧语义面（--bg-panel / --bg / --bg-alt）作代理。
SURFACES_NEW = [f"--surface-{i}" for i in range(5)]
SURFACES_LEGACY = ["--bg-panel", "--bg", "--bg-alt"]
# 派生交互面：只进 accent 门禁（九面），不进 --fg-dim 门禁——
# 方案 §5.2.3 对它们的规则是「染色面 / 控件底上禁用 --fg-dim，改用 --fg / --fg-muted」，
# 属批 2b 的**选择器级**扫描（门禁 6），不是 token 级对比度能判定的。
DERIVED_FACES = ["--hover", "--control-hover", "--selected", "--tab-inactive-bg"]

# 单色相门禁覆盖的 token 名（正则）。--on-accent 是白字、--accent-*-bg 类非色相项不参与。
HUE_AXIS_PATTERN = re.compile(
    r"^--(brand(-[a-z0-9]+)?|accent[a-z-]*|link[a-z-]*|focus-ring|diff-hunk|"
    r"welcome-glow|debug-frame-active|brand-gradient)$"
)
HUE_AXIS_SKIP = {"--on-accent"}

# 已登记残留：(theme, token, face) → 处置说明。命中即降级为 WARN（不拦门禁），
# 但必须在对应批次收口后从这里删除，否则会永久豁免。
KNOWN_RESIDUALS: dict[tuple[str, str, str], str] = {
    # 方案 §5.2.3：--fg-dim #5f5f68 打在现状 --control-hover #c8c8c8 上仅 3.78。
    # 彻底修好依赖批 2b 的浅色派生面重算（--control-hover → #e4e4e6，新值下 4.98 ✅）。
    ("light", "--fg-dim", "--control-hover"): "批 2b 浅色派生面重算（--control-hover → #e4e4e6）",
    # 现状深色 --control-hover #4b4b4b 是遗留的越阶值（比新 S4 还亮），
    # 批 2b 重算为 #3a3a42 后 --accent-emphasis 在其上为 5.53 ✅。
    ("dark", "--accent", "--control-hover"): "批 2b 派生面重算（--control-hover → #3a3a42）",
    # 同一个浅色遗留面 #c8c8c8：它同时压着 --fg-dim（3.78）与 --accent（3.49）两项，
    # 批 2b 重算为 #e4e4e6 后两者分别为 4.98 / 4.60 ✅。
    ("light", "--accent", "--control-hover"): "批 2b 浅色派生面重算（--control-hover → #e4e4e6）",
}

# ---------------------------------------------------------------- CSS 解析


def strip_comments(css: str) -> str:
    """去掉 /* ... */（token 块里有大段论证性注释，必须先剥）。"""
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def extract_block(css: str, selector: str) -> list[str]:
    """按选择器取块体（同一选择器可能出现多次，如两个 :root）。"""
    out: list[str] = []
    for m in re.finditer(re.escape(selector) + r"\s*\{", css):
        depth, i = 1, m.end()
        while i < len(css) and depth:
            if css[i] == "{":
                depth += 1
            elif css[i] == "}":
                depth -= 1
            i += 1
        out.append(css[m.end(): i - 1])
    return out


def parse_decls(body: str) -> dict[str, str]:
    """声明解析：`name: value;` → dict。值内可能含逗号/括号但不含分号。
    **只保留 `--` 自定义属性**（供 :root / light 覆盖层取 token）。"""
    out: dict[str, str] = {}
    for chunk in body.split(";"):
        if ":" not in chunk:
            continue
        name, _, value = chunk.partition(":")
        name = name.strip()
        if name.startswith("--"):
            out[name] = value.strip()
    return out


def parse_style_decls(body: str) -> dict[str, str]:
    """普通样式声明解析（保留全部属性；`--` 自定义属性也一并带上）。
    括号内的分号（如 `content: "a;b"`）不常见于本文件，按分号切分可接受。"""
    out: dict[str, str] = {}
    for chunk in body.split(";"):
        if ":" not in chunk:
            continue
        name, _, value = chunk.partition(":")
        name = name.strip()
        if not name or name.startswith("@") or name in ("from", "to"):
            continue
        out[name] = value.strip()
    return out


def load_tokens(css_path: Path) -> dict[str, dict[str, str]]:
    css = strip_comments(css_path.read_text(encoding="utf-8"))
    themes: dict[str, dict[str, str]] = {}
    for selector, theme in ((":root", "dark"), ('[data-theme="light"]', "light")):
        merged: dict[str, str] = {}
        for body in extract_block(css, selector):
            merged.update(parse_decls(body))
        themes[theme] = merged
    return themes


# ---------------------------------------------------------------- 选择器级引用扫描

@dataclass(frozen=True)
class Ref:
    """一处 token 引用：选择器 + 行号 + 引用它的属性。"""

    line: int
    selector: str
    prop: str
    scope: str  # 规则所在的作用域（@media / @supports 之类），无则空串


def scan_refs(css_path: Path, token: str) -> list[Ref]:
    """列出 `var(--token)` 的全部引用点（选择器级）。
    token 自带 `--` 前缀；用于批 2a 的旧 token 拆分与批 2b 的抬升面审计
    （方案 §7 门禁 6 / 18 都要求「选择器级扫描」，token 计数不足以判定）。"""
    raw_lines = css_path.read_text(encoding="utf-8").splitlines()
    # 注释剥离要保持行号，故逐行处理：把注释内容替换成等长空白
    lines: list[str] = []
    in_block = False
    for line in raw_lines:
        out, i = [], 0
        while i < len(line):
            if in_block:
                end = line.find("*/", i)
                if end < 0:
                    out.append(" " * (len(line) - i))
                    i = len(line)
                else:
                    out.append(" " * (end + 2 - i))
                    i = end + 2
                    in_block = False
            elif line.startswith("/*", i):
                out.append("  ")
                i += 2
                in_block = True
            else:
                out.append(line[i])
                i += 1
        lines.append("".join(out))

    refs: list[Ref] = []
    scope_stack: list[tuple[int, str]] = []  # (indent_level, at-rule)
    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()
        at = re.match(r"@(media|supports|container|layer)\b(.*)\{", stripped)
        if at:
            scope_stack.append((len(line) - len(line.lstrip()), at.group(1) + " " + at.group(2).strip()))
            continue
        if stripped.startswith("}") and scope_stack:
            indent = len(line) - len(line.lstrip())
            while scope_stack and scope_stack[-1][0] >= indent:
                scope_stack.pop()
            continue
        if f"var({token}" not in line:
            continue
        # 选择器归属：① 本行自带 `{`（单行规则）→ 取 `{` 之前的部分；
        # ② 否则往上找最近的、以 `{` 结尾且非 @开头的规则头
        selector, scope = "?", (scope_stack[-1][1] if scope_stack else "")
        if "{" in line and not stripped.startswith("@"):
            selector = line.split("{", 1)[0].strip()
        else:
            for back in range(idx - 1, max(0, idx - 400), -1):
                cand = lines[back - 1].strip()
                if cand.endswith("{") and not cand.startswith("@"):
                    selector = cand[:-1].strip()
                    break
        # 属性名：取紧邻 `var(--token)` 之前的那个声明名（单行多属性规则也能对）
        pos = line.index(f"var({token}")
        head = line[:pos]
        cut = max(head.rfind(";"), head.rfind("{"), head.rfind("}"))
        prop = head[cut + 1:].split(":", 1)[0].strip() or "?"
        refs.append(Ref(line=idx, selector=selector, prop=prop, scope=scope))
    return refs


def print_refs(css_path: Path, token: str) -> int:
    refs = scan_refs(css_path, token)
    print(f"var({token}) 引用 {len(refs)} 处 —— {css_path}\n")
    width = max((len(r.selector) for r in refs), default=10)
    for r in refs:
        scope = f"  @{r.scope}" if r.scope else ""
        print(f"  L{r.line:<5} {r.selector:<{min(width, 58)}}  {r.prop}{scope}")
    return len(refs)


# ---------------------------------------------------------------- 颜色

RGBA = tuple[float, float, float, float]  # 0-255 / alpha 0-1


def parse_color(value: str) -> RGBA | None:
    v = value.strip()
    m = re.match(r"^#([0-9a-f]{3,8})$", v, re.I)
    if m:
        h = m.group(1)
        if len(h) in (3, 4):
            r, g, b = (int(c * 2, 16) for c in h[:3])
            a = int(h[3] * 2, 16) / 255 if len(h) == 4 else 1.0
        else:
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
            a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return (r, g, b, a)
    m = re.match(r"^rgba?\(([^)]+)\)$", v, re.I)
    if m:
        parts = [p.strip() for p in m.group(1).split(",")]
        if len(parts) < 3:
            return None
        try:
            nums = [float(p.rstrip("%").strip()) for p in parts[:3]]
        except ValueError:
            return None
        alpha = float(parts[3]) if len(parts) > 3 else 1.0
        return (nums[0], nums[1], nums[2], alpha)
    return None


def gradient_colors(value: str) -> list[RGBA]:
    """取 linear-gradient 内的全部色标（色相门禁用）。"""
    out: list[RGBA] = []
    for token in re.findall(r"rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}", value):
        c = parse_color(token)
        if c:
            out.append(c)
    return out


def resolve(tokens: dict[str, str], name: str, depth: int = 0) -> RGBA | None:
    """递归解析 var() 引用 → RGBA；无法解析（如 linear-gradient）返回 None。"""
    if depth > 8:
        return None
    raw = tokens.get(name)
    if raw is None:
        return None
    m = re.fullmatch(r"var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,[^)]*)?\)", raw)
    if m:
        return resolve(tokens, m.group(1), depth + 1)
    return parse_color(raw)


def over(fg: RGBA, bg: RGBA) -> RGBA:
    """alpha 合成（token 大量使用半透明面）。"""
    a = fg[3]
    return tuple(fg[i] * a + bg[i] * (1 - a) for i in range(3)) + (1.0,)  # type: ignore[return-value]


def luminance(c: RGBA) -> float:
    def ch(v: float) -> float:
        s = v / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c[i]) for i in range(3))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(fg: RGBA, bg: RGBA) -> float:
    l1, l2 = luminance(fg), luminance(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def hue(c: RGBA) -> float | None:
    r, g, b = (c[i] / 255 for i in range(3))
    hi, lo = max(r, g, b), min(r, g, b)
    d = hi - lo
    if d < 1e-6:  # 灰/白/黑：色相无定义
        return None
    if hi == r:
        h = 60 * (((g - b) / d) % 6)
    elif hi == g:
        h = 60 * ((b - r) / d + 2)
    else:
        h = 60 * ((r - g) / d + 4)
    return h


def hue_delta(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return min(d, 360 - d)


def hexs(c: RGBA) -> str:
    return "#{:02x}{:02x}{:02x}".format(int(c[0]), int(c[1]), int(c[2])) + (
        f"{int(round(c[3] * 255)):02x}" if c[3] < 1 else ""
    )


# ---------------------------------------------------------------- 门禁


class Report:
    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.fails: list[str] = []
        self.warns: list[str] = []

    def check(self, gate: str, name: str, ok: bool, detail: str, residual: str | None = None) -> None:
        self.rows.append({"gate": gate, "item": name, "ok": ok, "detail": detail,
                          "residual": residual})
        if ok:
            return
        msg = f"[{gate}] {name}: {detail}"
        if residual:
            self.warns.append(f"{msg} —— 已登记残留：{residual}")
        else:
            self.fails.append(msg)


def faces_for(tokens: dict[str, str], group: str) -> list[str]:
    """面列表。新阶梯（--surface-*，批 2a 起）优先，批 1 回落到旧语义面。
    group="accent"：表面档 + 4 个派生交互面（九面门禁）。
    group="surface"：仅表面档（--fg-dim 门禁，方案 §7-3 的 L0–L3）。"""
    has_new = all(f"--surface-{i}" in tokens for i in range(4))
    surfaces = ([f"--surface-{i}" for i in range(4)] if has_new else SURFACES_LEGACY)
    if group == "surface":
        return surfaces
    if has_new and "--surface-4" in tokens:
        surfaces = surfaces + ["--surface-4"]
    return [*surfaces, *DERIVED_FACES]


def gate_hue_axis(report: Report, theme: str, tokens: dict[str, str]) -> None:
    base = resolve(tokens, "--brand")
    if base is None:
        report.check("单色相", f"{theme}/--brand", False, "--brand 未定义或不可解析")
        return
    base_h = hue(base)
    if base_h is None:
        report.check("单色相", f"{theme}/--brand", False, "--brand 无有效色相")
        return
    for name in sorted(tokens):
        if not HUE_AXIS_PATTERN.match(name) or name in HUE_AXIS_SKIP:
            continue
        raw = tokens[name]
        colors = gradient_colors(raw) if raw.startswith("linear-gradient") else (
            [resolve(tokens, name)] if resolve(tokens, name) else []
        )
        if not colors:
            continue
        for c in colors:
            h = hue(c)
            if h is None:
                continue  # 灰阶（如纯白字）不参与色相判定
            d = hue_delta(h, base_h)
            report.check("单色相", f"{theme}{name}={hexs(c)}", d <= HUE_TOLERANCE,
                         f"色相 {h:.1f}° vs 基准 {base_h:.1f}°（Δ{d:.1f}°）")


def gate_accent_faces(report: Report, theme: str, tokens: dict[str, str]) -> None:
    accent = resolve(tokens, "--accent")
    emph = resolve(tokens, "--accent-emphasis")
    if accent is None:
        report.check("accent 面", f"{theme}/--accent", False, "--accent 未定义或不可解析")
        return
    for face in faces_for(tokens, "accent"):
        bg = resolve(tokens, face)
        if bg is None:
            continue
        # 面自身可能半透明：先合成到该主题的画布底上
        canvas = resolve(tokens, "--bg") or (0, 0, 0, 1)
        bg_solid = over(bg, canvas)
        ca = contrast(accent, bg_solid)
        ce = contrast(emph, bg_solid) if emph else None
        if ca >= AA_TEXT:
            report.check("accent 面", f"{theme} --accent on {face}({hexs(bg_solid)})", True,
                         f"{ca:.2f} ✅ 可用 --accent")
        elif ce is not None and ce >= AA_TEXT:
            report.check("accent 面", f"{theme} --accent on {face}({hexs(bg_solid)})", True,
                         f"--accent {ca:.2f} ✗ → 须走 --accent-emphasis（{ce:.2f} ✅）")
        else:
            report.check("accent 面", f"{theme} --accent on {face}({hexs(bg_solid)})", False,
                         f"--accent {ca:.2f} ✗"
                         + (f" 且 --accent-emphasis 仅 {ce:.2f} ✗" if ce is not None
                            else " 且未定义 --accent-emphasis"),
                         residual=KNOWN_RESIDUALS.get((theme, "--accent", face)))


def gate_on_accent_fill(report: Report, theme: str, tokens: dict[str, str]) -> None:
    fill = resolve(tokens, "--accent-fill")
    on = resolve(tokens, "--on-accent")
    if fill is None:
        report.check("白字 on fill", f"{theme}/--accent-fill", False, "--accent-fill 未定义")
        return
    canvas = resolve(tokens, "--bg") or (0, 0, 0, 1)
    solid = over(fill, canvas)
    c = contrast(on or (255, 255, 255, 1), solid)
    report.check("白字 on fill", f"{theme} --on-accent on --accent-fill({hexs(solid)})",
                 c >= AA_TEXT, f"{c:.2f}")


def gate_fg_dim(report: Report, theme: str, tokens: dict[str, str]) -> None:
    dim = resolve(tokens, "--fg-dim")
    if dim is None:
        report.check("fg-dim 面", f"{theme}/--fg-dim", False, "--fg-dim 未定义")
        return
    canvas = resolve(tokens, "--bg") or (0, 0, 0, 1)
    for face in faces_for(tokens, "surface"):
        bg = resolve(tokens, face)
        if bg is None:
            continue
        solid = over(bg, canvas)
        c = contrast(dim, solid)
        report.check("fg-dim 面", f"{theme} --fg-dim on {face}({hexs(solid)})", c >= AA_TEXT,
                     f"{c:.2f}", residual=KNOWN_RESIDUALS.get((theme, "--fg-dim", face)))


# 抬升面判定：这些 token 的背景色属于「浮起来的那一层」，其上的次要文字不能用 --fg-dim，
# accent 类文字/图标必须走 --accent-emphasis（方案 §5.2.5 / §5.1 九面门禁）。
LIFTED_SURFACE_TOKENS = {
    "--surface-3", "--surface-4", "--bg-alt", "--control-hover", "--selected", "--hover",
}

# 继承来的「表面档」→ 不算抬升面（--fg-dim 在这些面上合规）
SURFACE_TOKENS = {"--surface-0", "--surface-1", "--surface-2", "--bg", "--bg-panel",
                  "--bg-chrome", "--tab-active-bg", "--tab-inactive-bg"}


@dataclass(frozen=True)
class Rule:
    """一条 CSS 规则（选择器组已按逗号拆开）。"""

    selector: str
    decls: dict[str, str]
    line: int


def parse_rules(css_path: Path) -> list[Rule]:
    """解析全部规则（注释已剥离，行号保持）。用于选择器级审计。
    字符级扫描 + at-rule 递归：**单行规则**（`sel { a: b; }`）也必须正确解析——
    早期版本按「行」切块，单行规则的声明全丢，扫描器静默返回 0 命中（假阴性）。"""
    text = "\n".join(strip_comments_keep_lines(css_path.read_text(encoding="utf-8")))
    rules: list[Rule] = []
    _parse_rules(text, rules, 0)
    return rules


def _split_selector_group(head: str) -> list[str]:
    """按逗号拆选择器组，但**不拆括号内**的逗号（`:is(a, b)` / `:not(x, y)`）。"""
    out: list[str] = []
    depth, cur = 0, ""
    for ch in head:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return [s for s in out if s and not s.startswith("@")]


def _parse_rules(text: str, out: list[Rule], line_offset: int = 0) -> None:
    i, n = 0, len(text)
    while i < n:
        j = text.find("{", i)
        if j < 0:
            return
        head = text[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if text[k] == "{":
                depth += 1
            elif text[k] == "}":
                depth -= 1
            k += 1
        body = text[j + 1:k - 1]
        line_no = text[:j].count("\n") + 1 + line_offset
        if head.startswith("@"):
            _parse_rules(body, out, line_no)  # 递归进 at-rule（@media / @supports / @keyframes）
        elif head:
            for sel in _split_selector_group(head):
                out.append(Rule(selector=sel, decls=parse_style_decls(body), line=line_no))
        i = k


def strip_comments_keep_lines(src: str) -> list[str]:
    """去注释但保持行数（选择器级审计需要行号）。"""
    out: list[str] = []
    in_block = False
    for line in src.splitlines():
        buf: list[str] = []
        i = 0
        while i < len(line):
            if in_block:
                end = line.find("*/", i)
                if end < 0:
                    i = len(line)
                else:
                    i = end + 2
                    in_block = False
            elif line.startswith("/*", i):
                i += 2
                in_block = True
            else:
                buf.append(line[i])
                i += 1
        out.append("".join(buf))
    return out


def _compound(selector: str) -> str:
    """取选择器最右一段（`#db-grid thead th` → `th`）。"""
    return selector.split()[-1] if selector.split() else selector


def background_index(rules: list[Rule]) -> dict[str, str]:
    """选择器 → 其背景 token（只认直接 var() 引用；多规则后者覆盖前者）。"""
    out: dict[str, str] = {}
    for r in rules:
        for prop in ("background", "background-color", "background-color:"):
            v = r.decls.get(prop)
            if v and v.startswith("var("):
                out[r.selector] = v[4:-1].strip()
    return out


def _ancestor_chain(selector: str) -> list[str]:
    """`#db-grid .db-conn-node.active` → ['#db-grid', '#db-grid .db-conn-node', '…active']"""
    parts = selector.split()
    return [" ".join(parts[: i + 1]) for i in range(len(parts))]


def gate_lifted_fg_dim(report: Report, rules: list[Rule]) -> None:
    """门禁 6：抬升面（S3/S4 及派生交互面）上 `--fg-dim` 引用 0 命中。
    背景判定走「同规则 → 最近祖先」两级解析，覆盖 `.foo { background } .foo .bar { color }` 同型写法。"""
    bg = background_index(rules)
    hits: list[str] = []
    for r in rules:
        color = r.decls.get("color")
        if color != "var(--fg-dim)":
            continue
        # 自身背景优先，否则沿后代组合子向上找最近祖先的背景
        surface = bg.get(r.selector)
        if surface is None:
            for anc in reversed(_ancestor_chain(r.selector)[:-1]):
                if anc in bg:
                    surface = bg[anc]
                    break
        if surface in LIFTED_SURFACE_TOKENS:
            hits.append(f"L{r.line} {r.selector}（背景 {surface}）")
    report.check("抬升面文字", "抬升面上 --fg-dim 引用为 0", not hits,
                 f"命中 {len(hits)} 处" + (f"：{hits[:4]}" if hits else " ✅"))


def gate_accent_on_lifted(report: Report, rules: list[Rule]) -> None:
    """门禁 18：S4 / hover / control-hover / selected 四个面上，accent 类文字/图标必须用
    `--accent-emphasis`——即这些面上不得再直接把 `--accent` 当文字色或边框色。"""
    bg = background_index(rules)
    hits: list[str] = []
    for r in rules:
        lifted = bg.get(r.selector)
        if lifted is None:
            for anc in reversed(_ancestor_chain(r.selector)[:-1]):
                if anc in bg:
                    lifted = bg[anc]
                    break
        if lifted not in {"--surface-4", "--hover", "--control-hover", "--selected"}:
            continue
        for prop in ("color", "border-color", "border-top-color", "border-bottom-color", "border-left-color"):
            v = r.decls.get(prop)
            if v == "var(--accent)":
                hits.append(f"L{r.line} {r.selector}（{prop}，背景 {lifted}）")
    report.check("accent 面归属", "四个亮面上的 accent 文字为 0 命中（改用 --accent-emphasis）",
                 not hits, f"命中 {len(hits)} 处" + (f"：{hits[:4]}" if hits else " ✅"))


def gate_ladder(report: Report, theme: str, tokens: dict[str, str]) -> None:
    """表面阶梯对比度，按**轴分档**（方案 §7-4）。
    刻意不设「任意相邻 ≥1.10」这种一刀切门禁：S0↔S1（外框↔侧栏）是刻意的弱差异，
    强行提到 1.15 会把侧栏与面板糊成一片。

    组件轴 / 浮层轴 / 端到端**只对深色设门禁**：方案 §5.2.1 明确「浅色不能照搬深色的亮度斜坡，
    浮层若比画布更亮，在白底上无处可更亮，只能靠投影 + hairline 表达层级」——
    浅色 L3 vs 画布实测 1.07、L4 = 画布同值是**设计值**，套用深色的 1.12/1.30 会把
    正确实现判负。浅色侧只保两道门禁：画布轴（外框↔画布）与侧栏保底。"""
    axes = [
        (("--surface-0", "--surface-2"), 1.15, "画布轴（外框 vs 画布，用户真正能感知的那一刀）", True, ""),
        (("--surface-1", "--surface-2"), 1.05, "侧栏 vs 画布（保底）", True, ""),
        (("--surface-2", "--surface-3"), 1.12, "组件轴（画布 vs 抬升面）", False,
         "浅色不设门禁：抬升面靠投影 + hairline 表达层级（§5.2.1）"),
        (("--surface-3", "--surface-4"), 1.12, "浮层轴（抬升面 vs hover）", False,
         "浅色不设门禁：浮层 = 画布同值，靠投影抬升（§5.2.1）"),
        (("--surface-0", "--surface-4"), 1.30, "端到端（外框 vs 浮层强调）", False,
         "浅色不设门禁：端到端由投影承担（§5.2.1）"),
    ]
    for (a, b), need, label, enforced, note in axes:
        ca, cb = resolve(tokens, a), resolve(tokens, b)
        if ca is None or cb is None:
            continue
        got = contrast(ca, cb)
        if enforced or theme == "dark":
            report.check("阶梯轴", f"{theme} {a}↔{b} {label}", got >= need,
                         f"{got:.2f}（门槛 ≥{need}）")
        else:
            report.check("阶梯轴", f"{theme} {a}↔{b} {label}", True,
                         f"{got:.2f}（仅记录）— {note}")


def gate_chrome_collision(report: Report, theme: str, tokens: dict[str, str]) -> None:
    """chrome 与面板底不得同色（方案 §7-17 的 token 级前置检查）。
    #menubar / #sidebar 若都落 S0，两者对比 1.00 —— 比改造前的 1.033 更糟，
    「用线框替代材质」的老问题会原样复现。"""
    chrome = resolve(tokens, "--bg-chrome")
    panel = resolve(tokens, "--bg-panel")
    if chrome is None or panel is None:
        return
    got = contrast(chrome, panel)
    report.check("chrome 分离", f"{theme} --bg-chrome vs --bg-panel", got >= 1.05,
                 f"{got:.2f}（门槛 ≥1.05，防 menubar/sidebar 同色）")


def gate_no_bare_shadow(report: Report, css_path: Path) -> None:
    """box-shadow 纪律（方案 §7-12）：除 --elev-* / --shadow 外不得有裸阴影值。

    豁免两类（都不是投影）：
      ① `none`——显式清除（内缩焦点环组用它把上方的双环关掉）；
      ② **spread-only 焦点环**：`0 0 0 Npx <色>`（零偏移零模糊、只有 spread）。
         这是方案 §5.8 的焦点环双环，不是投影——门禁若不放行，批 5a 会被自己的纪律项判负。
         判据是「无 x/y 偏移且无 blur」，故 `0 1px 2px …` 这类真投影仍会被拦下。
    另保留原有的语义色条豁免（inset 不透明色条：日志级别 / Git 指示条）。
    """
    text = strip_comments(css_path.read_text(encoding="utf-8"))
    bare: list[str] = []
    for m in re.finditer(r"box-shadow:\s*([^;]+);", text):
        val = m.group(1).strip()
        if "var(--elev-" in val or "var(--shadow)" in val:
            continue
        if val == "none":
            continue
        if re.fullmatch(r"inset\s+(?:[-\dpx]+\s+){3}var\(--[a-z-]+\)", val):
            continue  # 语义色条（inset 指示条 / 下划线，2~3px 宽的那种，不是投影）
        if all(re.fullmatch(r"0 0 0 \d+px var\(--[a-z-]+\)", part.strip())
               for part in val.split(",")):
            continue  # spread-only 焦点环（非投影）
        line = text[: m.start()].count("\n") + 1
        bare.append(f"L{line}: {val}")
    report.check("阴影纪律", "box-shadow 全部走 --elev-* / --shadow", not bare,
                 f"裸阴影 {len(bare)} 处" + (f"：{bare[:3]}" if bare else " ✅"))


def gate_easing_tokens(report: Report, css_path: Path) -> None:
    """门禁 20（方案 §7-11）：transition / animation 的**时间函数**必须走 `--ease-*`。

    判定式按方案 v1.2 的修正写：不能直接 grep `ease`（会命中 `var(--ease-out)` 自身），
    必须**先剥掉 `var(--ease-…)` 形式**再找裸关键字。只扫 `transition` / `animation` **简写**——
    `@keyframes` 内部实测不含任何时间函数（缓动写在使用它们的规则里）。

    `transition: none` / `animation: none` 天然不含关键字，天然豁免。
    """
    text = strip_comments(css_path.read_text(encoding="utf-8"))
    bare: list[str] = []
    for m in re.finditer(r"(?<![-\w])(transition|animation)\s*:\s*([^;]+);", text):
        val = m.group(2)
        probe = re.sub(r"var\(--ease-[a-z-]+\)", "", val)  # 先剥 token 形式
        if re.search(r"\b(ease-in-out|ease-out|ease-in|linear|cubic-bezier)\b", probe):
            line = text[: m.start()].count("\n") + 1
            bare.append(f"L{line}: {m.group(1)}: {val.strip()[:56]}")
    report.check("缓动纪律", "transition/animation 时间函数全部走 --ease-*", not bare,
                 f"裸缓动 {len(bare)} 处" + (f"：{bare[:3]}" if bare else " ✅"))


# 动效未挂 --motion 时的白名单：循环装饰动画。
# 不能靠「时长乘 var(--motion)」压制——motion=0 会让 duration 变成 0，infinite 循环将高频
# 闪成一团糊；正确做法是 animation:none（已由双通道规则压制），故此处登记豁免。
MOTION_EXEMPT = {"rx-progress-slide"}


def gate_motion_scaling(report: Report, css_path: Path) -> None:
    """门禁 21（方案 §7-16 的 token 级前置检查）：任何**有限时长的**动效都必须挂
    `var(--motion)`，否则「减少动画」开关与 `prefers-reduced-motion` 对它无效。

    方案 §7-16 要求「prefers-reduced-motion 下全部动效仍为 0」，但那是行为验收；
    本门禁是它的**成因检查**——漏挂 --motion 是这类回归唯一能在代码里看出来的痕迹。
    """
    text = strip_comments(css_path.read_text(encoding="utf-8"))
    offenders: list[str] = []
    for m in re.finditer(r"(?<![-\w])(transition|animation)\s*:\s*([^;]+);", text):
        val = m.group(2)
        if not re.search(r"\d", val):  # none / 纯 var(...)：无时长
            continue
        if "var(--motion)" in val:
            continue
        if any(x in val for x in MOTION_EXEMPT):
            continue
        line = text[: m.start()].count("\n") + 1
        offenders.append(f"L{line}: {m.group(1)}: {val.strip()[:56]}")
    report.check("动效可降级", "有限时长动效均挂 var(--motion)", not offenders,
                 f"未挂 --motion {len(offenders)} 处" + (f"：{offenders[:3]}" if offenders else " ✅"))


def gate_border_scale(report: Report, css_path: Path, tokens: dict[str, dict[str, str]]) -> None:
    """门禁 22（方案 §5.5）：边框三档 alpha 齐备，且兼容别名指向正确。

    ① 三档必须在**两套主题**下都定义（缺一档 → 引用它的规则颜色 unset 并继承父级）；
    ② `--border` 必须指向 subtle、`--border-soft` 必须指向 hairline —— 这两个是存量
       150 / 24 处的兼容入口，指错档等于把 174 处静默改到另一档；
    ③ 档位值必须是 **alpha 叠色**（rgba 且 a < 1）——实色边框是本批要消灭的对象，
       门禁守住「不许退回实色」这条不变量。
    """
    for theme in ("dark", "light"):
        t = tokens.get(theme, {})
        for name in ("--border-hairline", "--border-subtle", "--border-strong"):
            raw = t.get(name)
            if raw is None:
                report.check("边框纪律", f"{theme}/{name}", False, "未定义")
                continue
            a = re.search(r"rgba\([^)]*?,\s*([\d.]+)\s*\)", raw)
            if not a:
                report.check("边框纪律", f"{theme}/{name}", False,
                             f"应为 alpha 叠色 rgba(…, a)，实得 {raw}（实色边框是本批要消灭的对象）")
            else:
                report.check("边框纪律", f"{theme}/{name}", True, raw)
        # 兼容别名
        for alias, target, why in (
            ("--border", "--border-subtle", "150 处面板/控件边界的默认档"),
            ("--border-soft", "--border-hairline", "24 处细分隔线（menubar/状态栏/表格行）"),
        ):
            got = t.get(alias, "")
            report.check("边框纪律", f"{theme}/{alias} → {target}", got.strip() == f"var({target})",
                         f"{why}；实得 `{got or '(未定义)'}`")


def gate_overlay_hairline(report: Report, rules: list[Rule]) -> None:
    """门禁 23（方案 §5.5 配套）：浮层容器边框必须是 hairline。

    浮层已由 --elev-3 投影表达「浮起」，边框若还用常规档，会在投影之外再加一道硬边，
    读起来「厚一圈」。这是选择器级判定，token 计数判不了。
    """
    overlays = (".modal-card", ".ctx-menu", ".oc-tooltip", ".interp-popover")
    for r in rules:
        sel = r.selector
        if sel not in overlays:
            continue
        # Rule.decls 已按属性名拆好；边框可能写在 border / border-top / border-bottom 任一个上
        val = next((v for k, v in r.decls.items()
                    if k in ("border", "border-top", "border-bottom") and "solid" in v), None)
        if val is None:
            report.check("浮层描边", sel, False, "未找到 1px solid 边框声明（预期 hairline）")
            continue
        report.check("浮层描边", sel, "var(--border-hairline)" in val,
                     f"浮层容器边框应为 var(--border-hairline)，实得 `{val.strip()}`")


def gate_radius_scale(report: Report, tokens: dict[str, dict[str, str]]) -> None:
    """门禁 24（方案 §5.7）：圆角五档齐备且严格单调递增。

    档位值必须显式给 px 数值——写 `0.5rem` 之类会让「圆角占元素高度的比例」随根字号漂移，
    而本批 6px 的取值判断建立在「14px 元素配 6px 会变胶囊」这个比例推理上。
    """
    order = ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"]
    root = tokens.get("dark", {})
    vals: list[int] = []
    for name in order:
        raw = root.get(name)
        if raw is None:
            report.check("圆角档位", name, False, "未定义")
            vals.append(-1)
            continue
        m = re.fullmatch(r"(\d+)px", raw.strip())
        if not m:
            report.check("圆角档位", name, False, f"应为显式 px 数值，实得 `{raw}`（相对单位会让比例推理失效）")
            vals.append(-1)
        else:
            report.check("圆角档位", name, True, raw)
            vals.append(int(m.group(1)))
    if all(v >= 0 for v in vals):
        mono = all(a < b for a, b in zip(vals, vals[1:]))
        report.check("圆角档位", "五档严格递增 xs<sm<md<lg<xl", mono,
                     " → ".join(f"{n.replace('--radius-', '')}={v}px" for n, v in zip(order, vals))
                     + ("" if mono else " ❌ 非递增"))


# 裸圆角白名单：圆形语义 + 「与元素自身尺寸成比例」的一次性光学值（方案注释已登记）
BARE_RADIUS_EXEMPT = {
    "50%",  # 圆形（状态点、色卡、头像）
    ".activity-item.active::before",  # 2px 宽指示条的半宽圆角
    ".rx-progress",                   # 2px 高进度条的半宽圆角
}


def gate_no_bare_radius(report: Report, rules: list[Rule]) -> None:
    """门禁 25：border-radius 必须走 --radius-* token（方案 §5.7 的「禁止裸圆角」纪律）。

    存量 7 处裸值已在批 5c 归档 5 处；剩下 2 处 1px 是**与元素自身尺寸成比例**的光学值
    （2px 宽指示条 / 2px 高进度条），改成 3px 反而会让它变成半圆，故列入白名单保留。
    """
    bare: list[str] = []
    for r in rules:
        val = r.decls.get("border-radius")
        if not val:
            continue
        v = val.strip()
        if "var(--radius" in v or v == "50%":
            continue
        if v in ("1px",) and r.selector in BARE_RADIUS_EXEMPT:
            continue
        bare.append(f"L{r.line} {r.selector}: {v}")
    report.check("圆角纪律", "border-radius 全部走 --radius-*", not bare,
                 f"裸圆角 {len(bare)} 处" + (f"：{bare[:3]}" if bare else " ✅"))


def gate_small_element_radius(report: Report, rules: list[Rule]) -> None:
    """门禁 26：高度 ≤24px 的元素不得用 sm 及以上档（方案未提，批 5c 实测发现）。

    14–16px 高的元素（标签关闭钮、chip、徽标、scm 操作按钮）配 6px 圆角时，
    圆角占高度 37–43%，直接读成胶囊形。这是**让「sm = 控件主档」这条语义真正成立的前提**，
    不是额外的设计变更——方案 §5.7 只说「sm 是控件主档」，没说「主档要按元素尺寸校验」。
    """
    SMALL_MAX = 24
    offenders: list[str] = []
    for r in rules:
        val = r.decls.get("border-radius", "")
        if not re.search(r"var\(--radius-(sm|md|lg|xl)\)", val):
            continue
        h = r.decls.get("height", "").strip()
        m = re.fullmatch(r"(\d+)px", h)
        if m and int(m.group(1)) <= SMALL_MAX:
            offenders.append(f"L{r.line} {r.selector}: height {m.group(1)}px 但用 {val.strip()}")
    report.check("圆角档位", f"高度 ≤{SMALL_MAX}px 的元素用 xs 档", not offenders,
                 f"小元素误用主档 {len(offenders)} 处" + (f"：{offenders[:3]}" if offenders else " ✅"))


def audit(css_path: Path) -> Report:
    tokens = load_tokens(css_path)
    report = Report()
    for theme in ("dark", "light"):
        t = tokens.get(theme, {})
        if not t:
            report.check("解析", f"{theme} 块", False, "未找到该主题的 token 块")
            continue
        gate_hue_axis(report, theme, t)
        gate_accent_faces(report, theme, t)
        gate_on_accent_fill(report, theme, t)
        gate_fg_dim(report, theme, t)
        gate_ladder(report, theme, t)
        gate_chrome_collision(report, theme, t)
    gate_no_bare_shadow(report, css_path)
    rules = parse_rules(css_path)
    gate_lifted_fg_dim(report, rules)
    gate_accent_on_lifted(report, rules)
    gate_easing_tokens(report, css_path)
    gate_motion_scaling(report, css_path)
    gate_border_scale(report, css_path, tokens)
    gate_overlay_hairline(report, rules)
    gate_radius_scale(report, tokens)
    gate_no_bare_radius(report, rules)
    gate_small_element_radius(report, rules)
    return report


# ---------------------------------------------------------------- CLI


def main() -> int:
    ap = argparse.ArgumentParser(description="Pylume UI token 审计 + WCAG 门禁")
    ap.add_argument("--css", default=str(DEFAULT_CSS), help="style.css 路径")
    ap.add_argument("--json", action="store_true", help="输出 JSON（仍按门禁给退出码）")
    ap.add_argument("--out", help="把 JSON 报告写到该文件（逐批对照用；退出码不受影响）")
    ap.add_argument("--refs", metavar="TOKEN",
                    help="只做选择器级引用扫描：列出该 token 的全部引用点（选择器 + 行号 + 属性）；"
                         "TOKEN 写 `bg-panel` 或 `--bg-panel` 均可")
    args = ap.parse_args()

    css_path = Path(args.css)
    if not css_path.exists():
        print(f"找不到 CSS：{css_path}", file=sys.stderr)
        return 2

    if args.refs:
        print_refs(css_path, args.refs if args.refs.startswith("--") else f"--{args.refs}")
        return 0

    report = audit(css_path)

    if args.out:
        payload = {"css": str(css_path), "fails": report.fails, "warns": report.warns,
                   "rows": report.rows}
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"JSON 报告已写入 {out_path}")

    if args.json:
        print(json.dumps({"fails": report.fails, "warns": report.warns, "rows": report.rows},
                         ensure_ascii=False, indent=2))
        return 1 if report.fails else 0

    total = len(report.rows)
    bad = [r for r in report.rows if not r["ok"]]
    print(f"Pylume UI token 审计 —— {css_path}")
    print(f"共 {total} 项判定，未达标 {len(bad)} 项；FAIL {len(report.fails)} · WARN {len(report.warns)}\n")
    for gate in ("单色相", "accent 面", "白字 on fill", "fg-dim 面", "阶梯轴", "chrome 分离",
                 "阴影纪律", "抬升面文字", "accent 面归属"):
        rows = [r for r in report.rows if r["gate"] == gate]
        if not rows:
            continue
        print(f"── {gate}（{len(rows)} 项）")
        for r in rows:
            mark = "✅" if r["ok"] else ("⚠ " if r["residual"] else "❌")
            print(f"   {mark} {r['item']:<46} {r['detail']}")
        print()
    if report.warns:
        print("── 已登记残留（待后续批次收口，不拦门禁）")
        for w in report.warns:
            print(f"   ⚠ {w}")
        print()
    if report.fails:
        print("── FAIL")
        for f in report.fails:
            print(f"   ❌ {f}")
        return 1
    print("全部门禁通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
