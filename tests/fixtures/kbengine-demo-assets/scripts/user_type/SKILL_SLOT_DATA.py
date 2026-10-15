# -*- coding: utf-8 -*-
# types.xml <implementedBy>SKILL_SLOT_DATA.weapon_skill_slot_list_inst</implementedBy>
# 的实现模块:引擎按「模块路径.实现对象」装载,本文件即模块 SKILL_SLOT_DATA,
# weapon_skill_slot_list_inst 为实现对象(实例赋值形态)。
from KBEDebug import *


class weapon_skill_slot_list(object):
	def createFromStream(self, stream):
		count = stream.readUint32()
		return [stream.readUint32() for _ in range(count)]

	def addToStream(self, stream, value):
		stream.writeUint32(len(value))
		for item in value:
			stream.writeUint32(item)


weapon_skill_slot_list_inst = weapon_skill_slot_list()
