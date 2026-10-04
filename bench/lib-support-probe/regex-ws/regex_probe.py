"""P2 受控样本：静态引擎（pyrefly 1.3.1）对「字符串内 DSL」的支持度探针靶子。

每行都是一类真实痛点，探针逐个查 hover / completion / diagnostics：
- 正则：语法错、区间倒置、非 raw 串
- str.format：非法格式规范、未知字段
- %-format：非法格式码
"""

import re
from datetime import datetime

BAD = re.compile(r"([a-z")                                  # L1: 未闭合分组 → re.error
BAD_CLASS = re.compile(r"[z-a]+")                           # L2: 区间倒置
NONRAW = re.compile("\d+")                                  # L3: 非 raw 串（\d 被 Python 转义层吃掉）
GOOD = re.compile(r"\b(?P<user>\w+)@(?P<host>[\w.]+)", re.I | re.M)
HITS = GOOD.findall("alice@corp.com bob@corp.com")


def good_fmt() -> str:
    return "{:%Y-%m-%d %H:%M:%S}".format(datetime.now())


def bad_spec() -> str:
    return "{:q}".format(1)                                 # L4: 非法格式规范码 q


def bad_field() -> str:
    return "{nope}".format()                                # L5: 未知字段名


def bad_pct() -> str:
    return "%Q" % datetime.now()                            # L6: 非法 %-format 码
