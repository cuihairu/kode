# -*- coding: utf-8 -*-
# 接口 ROLE 的默认实现脚本(接口 def 的方法实现落 scripts/interfaces/<名>.py)。


class ROLE(object):
	def onMove(self, position):
		pass

	def requestAggro(self, entityId):
		"""测试模型补充(组合根验收):接口默认实现回调实体自身方法(onAggro 声明在 Monster.def,实现在 cell/Monster.py)。"""
		self.onAggro(entityId)
