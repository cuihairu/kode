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

    # 跨天调度:MRO 遍历调用全部 mixin 的 onCrossDay——执行顺序 = MRO 序中
    # 定义了该方法的类,即 HealthMixin → HistoryMixin → InventoryMixin(本类
    # 自己的 onCrossDay 是入口,不重复进链)。__mro__[1:] 跳过自身;
    # cls.__dict__.get 只取本类定义,getattr 会沿继承再命中已调过的实现。
    def onCrossDay(self):
        effects = []
        for cls in type(self).__mro__[1:]:
            handler = cls.__dict__.get('onCrossDay')
            if handler is not None:
                effects.append(handler(self))
        return effects
