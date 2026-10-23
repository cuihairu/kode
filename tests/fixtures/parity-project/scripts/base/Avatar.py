from scripts.common.Inventory import Inventory


class Avatar:

    def __init__(self):
        self.hp = 100
        self.bag = []
        self.inventory = Inventory()

    def onRpc(self, argOne):
        self.base.onRpc(argOne)

    def doAttack(self, targetId):
        self.cell.onCellRpc(targetId)
        self.

    def give(self, itemId):
        self.inventory.add(itemId)
        print(self.databaseID)
