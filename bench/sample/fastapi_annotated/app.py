"""FastAPI 注解齐全样例（bench：静态引擎上限考察）。

补全/跳转评测点（部分）：
- Item 字段补全（Pydantic 模型属性）
- create_item 参数类型推断
- app.get 装饰器链跳转
- response_model 返回类型补全
"""
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="bench-fastapi")


class Item(BaseModel):
    id: int
    name: str
    price: float
    tags: list[str] = []


class Order(BaseModel):
    order_id: int
    items: list[Item]
    total: float


@app.post("/items/", response_model=Item)
def create_item(item: Item) -> Item:
    return item


@app.get("/orders/{order_id}", response_model=Order)
def get_order(order_id: int) -> Order:
    return Order(
        order_id=order_id,
        items=[Item(id=1, name="widget", price=9.99, tags=["a", "b"])],
        total=9.99,
    )


def summarize(order: Order) -> float:
    # 评测点：order.items 元素类型推断 → Item 属性补全
    return sum(i.price for i in order.items)
