from .damage import DamageMixin


class EliteDamageMixin(DamageMixin):
    def compute_damage(self):
        return self.attackPower * 2
