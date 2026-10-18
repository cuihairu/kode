class InventoryMixin:
    def add_coins(self, amount):
        self.coins += amount
        return self.coins
