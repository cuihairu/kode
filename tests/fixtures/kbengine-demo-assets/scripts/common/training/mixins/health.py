class HealthMixin:
    def take_damage(self, amount):
        self.hp = max(0, self.hp - max(0, amount))
        return self.hp

    def heal(self, amount):
        self.hp = min(self.maxHp, self.hp + max(0, amount))
        return self.hp

    def reqHeal(self, amount):
        return self.heal(min(amount, 10))  # nav: same-class-heal
