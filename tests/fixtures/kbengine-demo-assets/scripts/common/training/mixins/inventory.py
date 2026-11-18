class InventoryMixin:
    def add_coins(self, amount):
        self.coins += amount
        return self.coins

    def onCrossDay(self):
        # 跨天钩子(MRO 遍历调度):每日签到补给
        return self.add_coins(100)
