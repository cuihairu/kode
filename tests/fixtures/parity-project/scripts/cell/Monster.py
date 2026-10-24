from scripts.base.Avatar import Avatar


class Monster(Avatar):

    def onSpawned(self, spawnAt):
        self.ferocity = 3
