# -*- coding: utf-8 -*-
# 客户端实体脚本(真实工程在客户端 App 内;此处入库供 kode 的
# scripts/{base,cell,client} 约定链走查)。
class Avatar(object):
	def onHPChanged(self, hp):
		print("Avatar.onHPChanged: %i" % hp)
