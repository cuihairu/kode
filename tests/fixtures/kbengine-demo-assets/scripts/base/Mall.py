# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *


# Mall 商城(DEMO-GAME-046 def 面):base-only 常驻商店实体。
# 引擎按实体名 import scripts/base/<Entity>.py(缺文件即
# ModuleNotFoundError 炸 baseapp 装载,022 真机判例);
# 购买账面 reqMallBuy 落 046 实现批。
class Mall(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		INFO_MSG("Mall[%i] created (goodsRevision=%i)" % (
			self.id, getattr(self, "goodsRevision", 0)))
