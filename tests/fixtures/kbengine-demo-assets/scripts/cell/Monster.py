# -*- coding: utf-8 -*-
import KBEngine
from Avatar import Avatar
from KBEDebug import *


# def 侧 <Parent> Avatar 的脚本面镜像:引擎 checkDefMethod 要求父类 def 合并
# 进来的方法(respawn/onMove)在子类脚本类上可达,脚本继承让它们经 MRO 命中。
class Monster(Avatar):
	def __init__(self):
		KBEngine.Entity.__init__(self)

	def onAggro(self, entityId):
		"""
		KBEngine method.
		仇恨目标变化
		"""
		DEBUG_MSG("Monster[%i].onAggro: %i" % (self.id, entityId))

	def onMove(self, position):
		"""
		interface ROLE.
		移动回调(接口混入方法,声明在 interfaces/ROLE.def)
		"""
		DEBUG_MSG("Monster[%i].onMove: %s" % (self.id, position))

	def think(self):
		"""测试模型补充(组合根验收):跨类调用父实体 Avatar 的方法(<Parent> Avatar 链)。"""
		self.respawn()
