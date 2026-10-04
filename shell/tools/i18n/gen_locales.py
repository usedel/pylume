# -*- coding: utf-8 -*-
"""生成 shell/src/i18n/locales/{zh-CN,en-US}/core.ts。

本脚本负责 HTML + 壳层通用文案的 core 域；大型功能域（如 git）由 gen_domain.py 单独生成。

输入：
- data/html_dict.json   —— index.html 自动抽取的词条（由 extract_html.py 产出）
- data/manual_zh.json   —— TS 侧 t() 直接引用的词条（手工登记）
- data/en_*.json        —— 英文翻译分片（与上面两份中文的 key 必须一一对应）

校验：中英文 key 集合不一致 / 出现空串立即报错退出（避免把半套语言包写进仓库）。
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "..", "..", "src", "i18n", "locales")
OUT_ZH = os.path.join(OUT, "zh-CN", "core.ts")
OUT_EN = os.path.join(OUT, "en-US", "core.ts")


def esc(s):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def emit(pairs, head):
    out = list(head)
    last = None
    for k in sorted(pairs):
        ns = k.split(".")[0]
        if ns != last:
            out.append(f"  // ---- {ns} ----")
            last = ns
        out.append(f'  "{k}": "{esc(pairs[k])}",')
    out.append("};")
    return "\n".join(out) + "\n"


def main():
    zh: dict = {}
    en: dict = {}
    dupes: list[str] = []

    def merge(dst: dict, path: str) -> None:
        for k, v in json.load(open(path, encoding="utf-8")).items():
            if k in dst:
                dupes.append(f"{k}（{os.path.basename(path)} 覆盖更早分片的值）")
            dst[k] = v

    merge(zh, os.path.join(DATA, "html_dict.json"))
    merge(zh, os.path.join(DATA, "manual_zh.json"))
    for f in sorted(os.listdir(DATA)):
        if f.startswith("en_") and f.endswith(".json"):
            merge(en, os.path.join(DATA, f))

    missing = sorted(k for k in zh if k not in en)
    extra = sorted(k for k in en if k not in zh)
    empty = sorted(k for k, v in zh.items() if not v.strip()) + sorted(k for k, v in en.items() if not v.strip())
    print(f"zh: {len(zh)}  en: {len(en)}")
    if dupes:
        print(f"!! 重复 key {len(dupes)} 条（后者静默覆盖前者，必须消除）: {dupes[:10]}")
    if missing:
        print(f"!! 缺英文 {len(missing)} 条: {missing[:10]}")
    if extra:
        print(f"!! 多余英文 {len(extra)} 条: {extra[:10]}")
    if empty:
        print(f"!! 空文案: {empty[:10]}")
    if dupes or missing or extra or empty:
        sys.exit(1)

    zh_txt = emit(zh, [
        "// 简体中文语言包「core 域」（真源）：key 来自 index.html 的 data-i18n* 标记与壳层通用 t() 引用。",
        "// 由 tools/i18n/gen_locales.py 生成；改动请回到 HTML / data/manual_zh.json，不要手改本文件。",
        "export const core = {",
    ])
    en_txt = emit(en, [
        "// English (US) 语言包「core 域」：与 zh-CN/core.ts 一一对应，由 Record<CoreKey, string> 校验。",
        'import type { CoreKey } from "../zh-CN/core";',
        "",
        "export const core: Record<CoreKey, string> = {",
    ])
    os.makedirs(os.path.dirname(OUT_ZH), exist_ok=True)
    os.makedirs(os.path.dirname(OUT_EN), exist_ok=True)
    open(OUT_ZH, "w", encoding="utf-8").write(
        zh_txt + "\n/** 本域文案 key：en-US/core.ts 的 Record<CoreKey, string> 由它派生。 */\nexport type CoreKey = keyof typeof core;\n"
    )
    open(OUT_EN, "w", encoding="utf-8").write(en_txt)
    print(f"已生成 core 域 {len(zh)} 条 → src/i18n/locales/{{zh-CN,en-US}}/core.ts")


if __name__ == "__main__":
    main()
