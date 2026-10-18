class BrainMixin:
    def choose_target(self, candidates):
        return next((target for target in candidates if target.hp > 0), None)

    def brain_turn(self, candidates):
        target = self.choose_target(candidates)  # nav: inherited-brain
        if target is not None:
            return self.attack(target)  # nav: sibling-combat
        return 0
