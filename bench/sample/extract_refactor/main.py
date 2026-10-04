"""Extract 重构探针靶场：选区式 code action（探针脚本按子串定位，改缩进/文案请同步 probe.cjs）。"""

TAX_RATE = 0.13


def total(price: int, qty: int) -> float:
    subtotal = price * qty
    return subtotal + subtotal * TAX_RATE


def main() -> None:
    price = 100
    qty = 3
    print(price * qty)
    print(total(price, qty))


if __name__ == "__main__":
    main()
