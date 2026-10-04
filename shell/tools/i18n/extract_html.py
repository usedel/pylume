# -*- coding: utf-8 -*-
"""扫描 shell/index.html，给含中文的文案打 data-i18n* 标记，并导出词条到 data/html_dict.json。

用法（在 shell/ 下）：python3 tools/i18n/extract_html.py

产出两件事：
1. 就地改写 index.html：属性 / 文本节点旁插入 `data-i18n`（文本）、`data-i18n-tip`（data-tip）、
   `data-i18n-aria`（aria-label）、`data-i18n-ph`（placeholder）、`data-i18n-title`（title）、
   `data-i18n-alt`（alt），值为分配到的 i18n key；
2. 写出 data/html_dict.json（key → 中文原文），供 gen_locales.py 生成 zh-CN.ts。

幂等性：重复执行不会重复插入（同一标签的同一属性只打一次），但**已改过的 key 不会被自动回退**——
若手动重命名了 key，请同步改 data/html_dict.json 与各语言包。
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C

HTML = os.path.join(HERE, "..", "..", "index.html")
DICT_OUT = os.path.join(HERE, "data", "html_dict.json")


def main():
    src = open(HTML, encoding="utf-8").read()
    hits = C.collect(src)
    lines = src.split("\n")
    for h in sorted(hits, key=lambda x: (x["line"], x["col"]), reverse=True):
        ln = h["line"] - 1
        s = lines[ln]
        if s[h["col"]] != "<":
            print(f"!! 位置偏移异常，放弃改写：line {h['line']} col {h['col']}")
            sys.exit(1)
        ins = h["col"] + 1 + len(h["tag"])
        lines[ln] = s[:ins] + f' {h["attr"]}="{h["key"]}"' + s[ins:]
    open(HTML, "w", encoding="utf-8").write("\n".join(lines))
    d = {}
    for h in hits:
        d.setdefault(h["key"], h["text"])
    json.dump(d, open(DICT_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"打标 {len(hits)} 处，词条 {len(d)} 条 → {os.path.relpath(DICT_OUT, os.path.join(HERE, '..', '..'))}")


if __name__ == "__main__":
    main()
