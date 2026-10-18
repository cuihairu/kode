from TrainingMonster import TrainingMonster
from training.mixins.elite import EliteDamageMixin


class EliteMonster(EliteDamageMixin, TrainingMonster):
    def find_enemy(self, candidates):
        return self.choose_target(candidates)  # nav: elite-inherited-target
