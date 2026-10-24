from .mix import (
    RunMixin as RM,
    Health,
)

class Base:
    def base(self):
        self.hp = 1

class Avatar(Base):
    @staticmethod
    def __init__(self):
        self.hp = 100
        self.name = "Avatar"

    async def run(self):
        self.level = 2

avatar = Avatar()

