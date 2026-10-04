from pydantic import BaseModel


class User(BaseModel):
    id: int
    name: str
    is_active: bool = True


class Admin(User):
    level: int = 1
