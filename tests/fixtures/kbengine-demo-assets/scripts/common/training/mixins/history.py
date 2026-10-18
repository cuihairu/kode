class HistoryMixin:
    def record_hit(self, target_id, damage):
        self.battleLog.append((target_id, damage))
