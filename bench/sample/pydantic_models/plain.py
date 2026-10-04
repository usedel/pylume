from dataclasses import dataclass


@dataclass
class Point:
    x: int
    y: str = "0"


p_bad_type = Point(x="not-an-int")
p_missing = Point()
