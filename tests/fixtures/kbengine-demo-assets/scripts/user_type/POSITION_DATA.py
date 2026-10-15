# -*- coding: utf-8 -*-
# types.xml <implementedBy>POSITION_DATA.position_inst</implementedBy> 的实现模块。
from KBEDebug import *


class position(object):
	def createFromStream(self, stream):
		return (stream.readFloat32(), stream.readFloat32(), stream.readFloat32())

	def addToStream(self, stream, value):
		for axis in value:
			stream.writeFloat32(axis)


position_inst = position()
