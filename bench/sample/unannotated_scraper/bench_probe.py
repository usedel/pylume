"""probe 开销基准目标脚本（Gate C：开销 < 1.5x；bench_probe.ps1 消费本文件）。

刻意无注解、纯 CPU（不联网）——2000 轮 × 3 函数的稳定负载：
- parse_page：dict 构造 + 列表推导（静态不可知的动态结构）
- normalize：循环 + 条件 + 字符串处理
- make_fetcher：闭包工厂 + 动态分发

输出单行 `bench: <sec> s (2000 rounds x 3 funcs)` 供 bench_probe.ps1 抓取计时
（README 的 Phase 2 开销表即本脚本产出；M4-4.1 正式基准复跑同一负载）。
"""


def parse_page(html):
    # 无注解：返回结构静态不可知
    return {
        "title": html.split("<title>")[1].split("</title>")[0],
        "links": [a for a in html.split('href="')[1::2]],
    }


def normalize(items):
    out = []
    for it in items:
        if it:
            out.append(it.strip().lower())
    return out


def make_fetcher(base_url):
    # 工厂函数：闭包 + 动态行为
    def _get(path):
        return base_url + path

    return _get


HTML = ('<html><title>bench</title>' + '<a href="x">y</a>' * 16) * 8


def main(rounds=2000):
    fetcher = make_fetcher("https://example.com")
    links = []
    for i in range(rounds):
        page = parse_page(HTML)
        links = normalize(page["links"])
        fetcher(f"/{i}")
    return len(links)


if __name__ == "__main__":
    import time
    import os

    rounds = int(os.environ.get("BENCH_ROUNDS", "2000"))
    t0 = time.perf_counter()
    main(rounds)
    dt = time.perf_counter() - t0
    print(f"bench: {dt:.3f} s ({rounds} rounds x 3 funcs)")
