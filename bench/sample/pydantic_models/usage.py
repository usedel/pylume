from models import Admin, User

good = User(id=1, name="Alice")
bad_type = User(id="not-an-int", name="Steve")
missing = User(id=1)
admin = Admin(id=2, name="Bob", level=3)
bad_admin = Admin(id=3, level="x")
