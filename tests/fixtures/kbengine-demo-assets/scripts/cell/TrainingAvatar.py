import KBEngine
import training.mixins.health as vitals
from training.mixins import (
    CriticalDamageMixin as Critical,
)
from training.mixins.combat import CombatMixin
from training.mixins.history import HistoryMixin
from training.mixins.inventory import InventoryMixin
from training.mixins.movement import BoundsMixin, MovementMixin
from training.mixins.rewards import RewardMixin


class TrainingAvatar(
    Critical,  # nav: reexported-base
    CombatMixin,
    vitals.HealthMixin,  # nav: qualified-base
    HistoryMixin,
    InventoryMixin,
    MovementMixin,
    BoundsMixin,
    RewardMixin,
    KBEngine.Entity,
):
    def __init__(self):
        KBEngine.Entity.__init__(self)
        self.battleLog = []

    def reqAttack(self, target_id):
        target = KBEngine.entities.get(target_id)
        if target is None or target is self:
            return 0
        return self.attack(target)  # nav: avatar-attack

    def drink_potion(self):
        if self.potions <= 0 or self.hp <= 0:
            return self.hp
        self.potions -= 1
        return self.reqHeal(10)  # nav: implementation-before-def

    def runtime_role(self):
        return "cell"

    def describe_role(self):
        return self.runtime_role()  # nav: cell-role

    def show_health(self):
        return self.hp  # nav: inherited-property
