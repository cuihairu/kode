class HealthMixin:
    def take_damage(self, amount):
        self.hp = max(0, self.hp - max(0, amount))
        return self.hp

    def heal(self, amount):
        self.hp = min(self.maxHp, self.hp + max(0, amount))
        return self.hp

    def reqHeal(self, amount):
        return self.heal(min(amount, 10))  # nav: same-class-heal

    def onCrossDay(self):
        # 跨天钩子(MRO 遍历调度):回满血。执行序见 TrainingAvatar.onCrossDay
        return self.heal(self.maxHp)
