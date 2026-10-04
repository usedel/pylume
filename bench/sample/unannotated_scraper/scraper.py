"""无注解爬虫样例（bench：运行时采样价值考察）。

刻意无类型注解、动态结构多——静态引擎在此场景弱，
Phase 2/3 的 pylume-probe/intel 主战场：
- parse_page 返回 dict，静态无法推断字段
- 工厂函数 make_fetcher 返回闭包，动态分发
- 插件式 handler 注册表
"""

import requests


def fetch(url, timeout=10):
    resp = requests.get(url, timeout=timeout)
    return resp.text


def parse_page(html):
    # 无注解：返回结构静态不可知
    return {
        "title": html.split("<title>")[1].split("</title>")[0],
        "links": [a for a in html.split('href="')[1::2]],
    }


def make_fetcher(base_url):
    # 工厂函数：闭包 + 动态行为
    session = requests.Session()

    def _get(path):
        return session.get(base_url + path)

    return _get


# 插件式 handler 注册表（静态必翻车场景）
HANDLERS = {}


def register(name):
    def deco(fn):
        HANDLERS[name] = fn
        return fn

    return deco


@register("page")
def handle_page(data):
    return parse_page(data)


def run():
    fetcher = make_fetcher("https://example.com")
    for name, handler in HANDLERS.items():
        print("handler:", name, handler)


if __name__ == "__main__":
    run()
