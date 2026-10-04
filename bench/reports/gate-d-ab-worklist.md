# Gate D 人工对标工作单（PyCharm 同场景）

> 由 `cargo test -p pylume-intel -- --nocapture runtime_completion_accuracy` 自动导出（设 `OC_GATE_D_WORKLIST=<路径>`）。
> **Pylume 两列已由测试填好**，人只需在 PyCharm 打开 `bench/sample/unannotated_scraper/` 同一样例、
> 在下表「光标位置」处触发补全，勾选期望 label 是否出现在 **top-5**。
> 判定口径与 `bench/reports/gate-d-runtime-completion.md` 一致：期望 label 出现在 top-5 即命中。

> 读法：`▏` = 光标位置（在此触发补全），`↵` = 换行（同一列里换行只是排版，代码本身是一行接一行）。
> 例：``data = parse_page(html)↵print(data["▏`` 表示在 `data["` 后触发补全。

| # | 形态 | 期望 label | 光标位置 | Pylume 实际排名 | Pylume 命中 | PyCharm 命中（人工填） | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | ① 函数返回 dict → 字段 | `title` | `data = parse_page(html)↵print(data["▏` | 2 | ✅ | ☐ | |
| 2 | ① 函数返回 dict → 字段 | `links` | `data = parse_page(html)↵print(data["▏` | **1** | ✅ | ☐ | |
| 3 | ① 函数返回 dict → 字段（前缀 tit） | `title` | `data = parse_page(html)↵print(data["tit▏` | **1** | ✅ | ☐ | |
| 4 | ① 函数返回 dict → 字段（前缀 li） | `links` | `data = parse_page(html)↵print(data["li▏` | **1** | ✅ | ☐ | |
| 5 | ② 工厂返回自定义实例 → 属性 | `id` | `o = make_order(c)↵print(o.▏` | 2 | ✅ | ☐ | |
| 6 | ② 工厂返回自定义实例 → 属性 | `customer` | `o = make_order(c)↵print(o.▏` | **1** | ✅ | ☐ | |
| 7 | ② 工厂返回自定义实例 → 属性 | `items` | `o = make_order(c)↵print(o.▏` | 3 | ✅ | ☐ | |
| 8 | ② 工厂返回自定义实例 → 属性 | `total` | `o = make_order(c)↵print(o.▏` | 4 | ✅ | ☐ | |
| 9 | ② 工厂返回自定义实例 → 属性（前缀 cu） | `customer` | `o = make_order(c)↵print(o.cu▏` | **1** | ✅ | ☐ | |
| 10 | ② 工厂返回自定义实例 → 属性（前缀 it） | `items` | `o = make_order(c)↵print(o.it▏` | **1** | ✅ | ☐ | |
| 11 | ③ 商品字典字段 | `sku` | `p = fetch_product(sku)↵print(p["▏` | 3 | ✅ | ☐ | |
| 12 | ③ 商品字典字段 | `name` | `p = fetch_product(sku)↵print(p["▏` | **1** | ✅ | ☐ | |
| 13 | ③ 商品字典字段（前缀 na） | `name` | `p = fetch_product(sku)↵print(p["na▏` | **1** | ✅ | ☐ | |
| 14 | ③ 商品字典字段（前缀 pr） | `price` | `p = fetch_product(sku)↵print(p["pr▏` | **1** | ✅ | ☐ | |
| 15 | ③ 商品字典字段（前缀 st） | `stock` | `p = fetch_product(sku)↵print(p["st▏` | **1** | ✅ | ☐ | |
| 16 | ④ 用户实例属性 | `name` | `u = get_user(uid)↵print(u.▏` | 2 | ✅ | ☐ | |
| 17 | ④ 用户实例属性 | `email` | `u = get_user(uid)↵print(u.▏` | **1** | ✅ | ☐ | |
| 18 | ④ 用户实例属性（前缀 em） | `email` | `u = get_user(uid)↵print(u.em▏` | **1** | ✅ | ☐ | |
| 19 | ④ 用户实例属性（前缀 ro） | `roles` | `u = get_user(uid)↵print(u.ro▏` | **1** | ✅ | ☐ | |
| 20 | ⑤ for 循环变量（list[User]） | `name` | `for u in list_users():↵    print(u.▏` | 2 | ✅ | ☐ | |
| 21 | ⑤ for 循环变量（list[User]） | `email` | `for u in list_users():↵    print(u.▏` | **1** | ✅ | ☐ | |
| 22 | ⑥ 函数参数类型观测 | `id` | `def handle_order(order):↵    return order.▏` | 2 | ✅ | ☐ | |
| 23 | ⑥ 函数参数类型观测 | `customer` | `def handle_order(order):↵    return order.▏` | **1** | ✅ | ☐ | |

## 小结（人工填）

- Pylume 命中：23/23
- PyCharm 命中：___/23（人工填）
- 结论（人工填）：☐ Pylume ≥ PyCharm　☐ Pylume < PyCharm　☐ 持平
