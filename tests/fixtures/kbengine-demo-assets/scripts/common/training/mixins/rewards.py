class RewardMixin:
    def collect_reward(self, target):
        self.add_coins(target.rewardCoins)  # nav: sibling-inventory
        self.experience += target.rewardXp
