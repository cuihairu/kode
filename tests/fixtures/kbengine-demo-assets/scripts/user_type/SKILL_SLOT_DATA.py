# -*- coding: utf-8 -*-
# types.xml <implementedBy>SKILL_SLOT_DATA.weapon_skill_slot_list_inst</implementedBy>
# 的实现模块:引擎按「模块路径.实现对象」装载,本文件即模块 SKILL_SLOT_DATA,
# weapon_skill_slot_list_inst 为实现对象(实例赋值形态)。
from KBEDebug import *


class serializer_base(object):
	"""测试模型补充(组合根验收):user_type 序列化器共享基类(模板方法形态)。"""

	def bootstrap(self):
		self.reindex()


class weapon_skill_slot_list(serializer_base):
	def __init__(self):
		self._slots = []
		self._count = 0

	def reindex(self):
		"""测试模型补充(组合根验收):模板方法的具体实现(组合根 weapon_skill_slot_list 的落点)。"""
		return 0

	def start(self):
		"""测试模型补充(放弃收窄验收):调用 mixin 基类 serializer_base(不在任何 .def)的方法。"""
		self.bootstrap()

	def createFromStream(self, stream):
		count = stream.readUint32()
		return [stream.readUint32() for _ in range(count)]

	def addToStream(self, stream, value):
		stream.writeUint32(len(value))
		for item in value:
			stream.writeUint32(item)

	# 引擎 FIXED_DICT implementedBy 契约(datatype.cpp:2383-2397):实现对象必须
	# 暴露 createObjFromDict/getDictFromObj/isSameType,缺任一即
	# DataTypes::loadTypes parse FIXED_DICT error 拒载(真引擎起服验证发现)。
	def createObjFromDict(self, dictData):
		inst = weapon_skill_slot_list()
		inst._slots = list(dictData.get("slot_list", []))
		inst._count = int(dictData.get("count", 0))
		return inst

	def getDictFromObj(self, obj):
		return {"slot_list": list(obj._slots), "count": obj._count}

	def isSameType(self, obj):
		return isinstance(obj, weapon_skill_slot_list)

	def asDict(self):
		return {"slot_list": list(self._slots), "count": self._count}


weapon_skill_slot_list_inst = weapon_skill_slot_list()
