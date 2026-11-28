# -*- coding: utf-8 -*-
import KBEngine
from KBEDebug import *
from Item import Item


# Talisman 符箓(DEMO-GAME-016):Parent=Item 的脚本镜像继承。
# 消耗面在 Avatar 基座(consume_talisman 纯函数核);本类只承载
# charges/power 持久化与耗尽自毁锚。
class Talisman(Item):
	def __init__(self):
		Item.__init__(self)
