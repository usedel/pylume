#!/usr/bin/env python3
"""由「域词条 JSON」生成语言包域文件（zh-CN/<domain>.ts 与 en-US/<domain>.ts）。

配合 apply_ts.py：它改完源码后产出 `data/<ns>_zh.json`（中文原文，占位符 `{name}`），
人工补 `data/<ns>_en.json` 后跑本脚本，即可得到两侧域文件。

复数处理：中文值里含 `{count}` 的条目会自动展开成 `<key>.one` / `<key>.other` 两份
（中文两种形式同文——`Intl.PluralRules("zh-CN")` 永远返回 other）。英文侧必须自己提供
两个变体，否则 tsc 会因 `Record<GitKey, string>` 缺 key 报错——这正是「漏译在编译期炸掉」
的预期行为。

用法：
    python3 tools/i18n/gen_domain.py --domain git                 # zh 必存，en 缺失则报错
    python3 tools/i18n/gen_domain.py --domain git --allow-missing  # en 缺失时用中文占位（先跑通再补译）
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCALES = ROOT / "src/i18n/locales"


def ts_str(s: str) -> str:
    """JSON 字符串字面量与 TS 兼容（\\n \\\\ \\" 转义规则一致），直接复用。"""
    return json.dumps(s, ensure_ascii=False)


def expand_plural(entries: dict[str, str]) -> dict[str, str]:
    """含 `{count}` 的 key 展开成 .one / .other 两份（中文两形同文）。

    已经写成 `.one` / `.other` 的条目不重复展开——英文侧两形不同，必须自己提供，
    若再展开会得到 `xxx.one.one` 这种废 key。
    """
    out: dict[str, str] = {}
    for k, v in entries.items():
        if "{count}" in v and not k.endswith((".one", ".other")):
            out[f"{k}.one"] = v
            out[f"{k}.other"] = v
        else:
            out[k] = v
    return out


def emit(domain: str, entries: dict[str, str], side: str) -> str:
    cap = domain.capitalize()
    lines = []
    if side == "zh":
        lines.append(
            f"// 简体中文语言包「{domain} 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、"
            f"gen_domain.py 生成，勿手改（改动请回到源码与 data/{domain}_zh.json）。"
        )
        lines.append(f"// 复数条目（含 {{count}}）自动展开 .one/.other 两份——中文两形同文。")
        lines.append(f"export const {domain} = {{")
    else:
        lines.append(
            f"// English (US) 语言包「{domain} 域」：key 与 zh-CN/{domain}.ts 一一对应，"
            f"Record<{cap}Key, string> 在编译期强校验漏译。"
        )
        lines.append(f'import type {{ {cap}Key }} from "../zh-CN/{domain}";')
        lines.append("")
        lines.append(f"export const {domain}: Record<{cap}Key, string> = {{")

    # 按 key 的第三段（git.<group>.<name>）分组加注释，便于人读与 review
    last_group = None
    for k, v in sorted(entries.items()):
        parts = k.split(".")
        group = ".".join(parts[:2]) if len(parts) > 2 else parts[0]
        if group != last_group:
            lines.append(f"  // ---- {group} ----")
            last_group = group
        lines.append(f"  {ts_str(k)}: {ts_str(v)},")
    lines.append("};")
    if side == "zh":
        lines.append("")
        lines.append(
            f"/** 本域文案 key：en-US/{domain}.ts 的 Record<{cap}Key, string> 由它派生。 */"
        )
        lines.append(f"export type {cap}Key = keyof typeof {domain};")
    return "\n".join(lines) + "\n"


def main() -> int:
    argv = sys.argv[1:]
    domain = argv[argv.index("--domain") + 1]
    allow = "--allow-missing" in argv
    data = Path(__file__).parent / "data"
    zh = json.loads((data / f"{domain}_zh.json").read_text(encoding="utf-8"))
    en_path = data / f"{domain}_en.json"
    if en_path.exists():
        en = json.loads(en_path.read_text(encoding="utf-8"))
    elif allow:
        print("! 缺英文词条：先用中文占位（提交前务必补译）", file=sys.stderr)
        en = dict(zh)
    else:
        print(f"✗ 缺 data/{domain}_en.json（补译后再跑，或加 --allow-missing 先占位）", file=sys.stderr)
        return 1

    zh_x = expand_plural(zh)
    en_x = expand_plural(en)
    missing = sorted(set(zh_x) - set(en_x))
    extra = sorted(set(en_x) - set(zh_x))
    if missing:
        print(f"✗ 英文缺 {len(missing)} 条：", file=sys.stderr)
        for k in missing[:20]:
            print(f"   - {k}", file=sys.stderr)
        return 1
    if extra:
        print(f"✗ 英文多 {len(extra)} 条（中文真源里没有）：", file=sys.stderr)
        for k in extra[:20]:
            print(f"   + {k}", file=sys.stderr)
        return 1

    (LOCALES / "zh-CN" / f"{domain}.ts").write_text(emit(domain, zh_x, "zh"), encoding="utf-8")
    (LOCALES / "en-US" / f"{domain}.ts").write_text(emit(domain, en_x, "en"), encoding="utf-8")
    print(f"✓ zh-CN/{domain}.ts ({len(zh_x)} 条)  en-US/{domain}.ts ({len(en_x)} 条)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
