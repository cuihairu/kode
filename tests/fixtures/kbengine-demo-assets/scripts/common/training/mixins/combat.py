from .damage import DamageMixin


class CombatMixin(DamageMixin):
    def attack(self, target):
        if self.hp <= 0 or target.hp <= 0:
            return 0
        damage = self.compute_damage()  # nav: runtime-damage
        target.take_damage(damage)
        self.record_hit(target.id, damage)  # nav: sibling-history
        if target.hp == 0:
            self.collect_reward(target)  # nav: sibling-reward
        return damage
