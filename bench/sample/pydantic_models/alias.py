from pydantic import BaseModel, ConfigDict, Field


class Aliased(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    my_field: str = Field(alias="my_alias")


a1 = Aliased(my_alias="foo")
a2 = Aliased(my_field="foo")
