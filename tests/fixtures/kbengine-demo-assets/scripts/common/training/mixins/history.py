class HistoryMixin:
    def record_hit(self, target_id, damage):
        self.battleLog.append((target_id, damage))

    def onCrossDay(self):
        # 跨天钩子(MRO 遍历调度):归档当日战斗日志
        archived = self.battleLog
        self.battleLog = []
        return len(archived)
