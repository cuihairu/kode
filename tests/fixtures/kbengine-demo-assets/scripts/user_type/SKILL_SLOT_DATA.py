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


weapon_skill_slot_list_inst = weapon_skill_slot_list()
