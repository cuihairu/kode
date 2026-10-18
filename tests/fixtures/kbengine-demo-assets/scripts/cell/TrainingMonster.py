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
