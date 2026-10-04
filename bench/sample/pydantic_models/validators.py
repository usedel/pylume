from pydantic import BaseModel, field_validator, model_validator


class V(BaseModel):
    x: int

    @field_validator("x")
    @classmethod
    def check_x(cls, v: int) -> int:
        return v if v > 0 else 0

    @model_validator(mode="after")
    def check_all(self) -> "V":
        return self
