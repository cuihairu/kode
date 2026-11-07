# -*- coding: utf-8 -*-
# types.xml <implementedBy>POSITION_DATA.position_inst</implementedBy> 的实现模块。
from KBEDebug import *


class position(object):
	def __init__(self):
		self._dict = {"x": 0.0, "y": 0.0, "z": 0.0}

	def createFromStream(self, stream):
		return (stream.readFloat32(), stream.readFloat32(), stream.readFloat32())

	def addToStream(self, stream, value):
		for axis in value:
			stream.writeFloat32(axis)

	# 引擎 FIXED_DICT implementedBy 契约(datatype.cpp:2383-2397),同 SKILL_SLOT。
	def createObjFromDict(self, dictData):
		inst = position()
		inst._dict = {"x": dictData.get("x", 0.0), "y": dictData.get("y", 0.0), "z": dictData.get("z", 0.0)}
		return inst

	def getDictFromObj(self, obj):
		return dict(obj._dict)

	def isSameType(self, obj):
		return isinstance(obj, position)

	def asDict(self):
		return dict(self._dict)


position_inst = position()
