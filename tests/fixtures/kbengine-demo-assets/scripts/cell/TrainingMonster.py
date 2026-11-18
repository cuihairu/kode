import KBEngine
from training.mixins.brain import BrainMixin
from training.mixins.combat import CombatMixin
from training.mixins.health import HealthMixin
from training.mixins.history import HistoryMixin
from training.mixins.inventory import InventoryMixin
from training.mixins.rewards import RewardMixin


class TrainingMonster(
    BrainMixin,
    CombatMixin,
    HealthMixin,
    HistoryMixin,
    InventoryMixin,
    RewardMixin,
    KBEngine.Entity,
):
    def __init__(self):
        KBEngine.Entity.__init__(self)
        self.battleLog = []

    def tick(self, candidates):
        return self.brain_turn(candidates)  # nav: monster-brain

    # 跨天调度:同 TrainingAvatar——Monster 根上的链序同为
    # HealthMixin → HistoryMixin → InventoryMixin(MRO 由基类声明序决定,
    # 与根类无关的同名钩子按各自根的 MRO 独立推导)。
    def onCrossDay(self):
        effects = []
        for cls in type(self).__mro__[1:]:
            handler = cls.__dict__.get('onCrossDay')
            if handler is not None:
                effects.append(handler(self))
        return effects
