from .damage import DamageMixin


class DamageMixin(DamageMixin):
    """Same class name, different module; the imported parent is not self."""

    def compute_damage(self):
        return self.attackPower + 4
