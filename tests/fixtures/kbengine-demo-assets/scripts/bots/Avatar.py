# -*- coding: utf-8 -*-
# bots 侧的 Avatar 客户端实体(无头玩家):服务端 giveClientTo 后由 bots 进程创建。
#
# 引擎取证四点(全部真机踩出):
# 1) bots 进程无 KBEngine.entities 模块面、客户端实体也无 self.entities
#    (bots 只注册 "bots" 模块,bots.cpp:180;entities 描述子挂在
#    ClientObjectBase,不在脚本 Entity 上)——客户端无法自行枚举索敌。
# 2) bots 进程客户端实体无脚本计时器面(bots.out "assertion failed: g_pApp
#    ... at: addTimer")——动作全由回调驱动。
# 3) cell 侧 self.client 依赖 witness 链(cellapp/entity.cpp
#    pyGetClientEntityCall),bots 真机恒 None——cell→client 直推死路,
#    客户端推送须经基座中继(onRadarPush BaseMethods → base.client)。
# 4) client_lib moveToPoint(client_lib/entity.cpp:29)调用可受理,但其
#    0.1s ScriptCallbacks 计时器在 bots 进程不泵(真机:调用后无
#    onMoveOver/onMoveFailure 回调)——客户端位移面死路,走位改服务端权威:
#    reqGoto(exposed)→ cell moveToPoint,视图同步回推位置。
# 因此走服务端雷达模式:入场 ping 最近存活怪 + 受击推攻击者位置(经基座
# 中继 onMonsterNear),无头玩家据此 reqGoto 走位、贴身即 cell.reqAttack
# 回击——登录→建角色→移动→攻击→击杀奖励→升级→死亡重生完整回路不依赖 Unity。
import KBEngine
from KBEDebug import *
from DemoConsts import DEMO_ATTACK_RANGE


class Avatar(KBEngine.Entity):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		self.lastTargetId = 0
		self.aiMoving = False
		INFO_MSG("bots Avatar[%s] client entity created, pos=%s" % (self.id, getattr(self, "position", None)))
		msg = "bots Avatar[%s] client entity created (entity sync), pos=%s" % (self.id, getattr(self, "position", None))
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def _fightAt(self, monsterId, x, z):
		"""雷达目标:近身即回击(exposed cell 方法),远处 reqGoto 服务端走位。"""
		if monsterId != self.lastTargetId:
			msg = "bots Avatar[%s] target Monster[%s] radar=(%.1f,%.1f)" % (self.id, monsterId, x, z)
			print("[demo-evidence] %s" % msg, flush=True)
			evidenceLog(msg)
			self.lastTargetId = monsterId
			# 换目标即重走位:登录同步窗口内发出的 cell 面调用会被引擎丢弃
			# (真机:入场即发的 reqGoto 10/10 未达),下一推(受击雷达)补发即达。
			self.aiMoving = False
		dist = ((self.position.x - x) ** 2 + (self.position.z - z) ** 2) ** 0.5
		if dist <= DEMO_ATTACK_RANGE:
			self.aiMoving = False
			if self.cell is not None:
				self.cell.reqAttack(monsterId)
			return
		if not self.aiMoving:
			self.aiMoving = True
			msg = "bots Avatar[%s] move toward Monster[%s] from (%.1f,%.1f) dist=%.1f" % (
				self.id, monsterId, self.position.x, self.position.z, dist,
			)
			print("[demo-evidence] %s" % msg, flush=True)
			evidenceLog(msg)
			# 引擎取证:client_lib moveToPoint 靠 0.1s ScriptCallbacks 计时器驱动,
			# 该计时器在 bots 进程不泵(真机:调用后无 onMoveOver/onMoveFailure 回调);
			# 客户端位移面死路,改服务端权威走位:reqGoto(exposed)→ cell 走向
			# 雷达目标 moveToPoint(客户端发令,服务端移动并经视图同步回推)。
			if self.cell is not None:
				self.cell.reqGoto()

	def onMonsterNear(self, x, z, monsterId):
		"""
		Client method.(Avatar.def ClientMethods,服务端雷达推送:受击时攻击者位置)
		"""
		self._fightAt(monsterId, x, z)

	def onEnterWorld(self):
		"""
		KBEngine method.(客户端实体进场:玩法回路起点)
		"""
		msg = "bots Avatar[%s] onEnterWorld pos=(%.1f,%.1f)" % (self.id, self.position.x, self.position.z)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onMoveOver(self, controllerId, userarg):
		"""
		KBEngine method.(客户端 moveToPoint 到点,client_lib/moveto_point_handler.cpp:54)
		到点即回击最后雷达目标(若仍锁定)。
		"""
		self.aiMoving = False
		msg = "bots Avatar[%s] arrived (%.1f,%.1f)" % (self.id, self.position.x, self.position.z)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		if self.lastTargetId and self.cell is not None:
			self.cell.reqAttack(self.lastTargetId)

	def onMoveFailure(self, controllerId, userarg):
		"""
		KBEngine method.(客户端移动失败:目标丢失等,清走位状态)
		"""
		self.aiMoving = False
		msg = "bots Avatar[%s] move FAILED (pos=%.1f,%.1f)" % (
			self.id, self.position.x, self.position.z,
		)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onLevelUp(self, newLevel):
		"""
		Client method.(Avatar.def ClientMethods)
		"""
		msg = "bots Avatar[%s] onLevelUp level=%s" % (self.id, newLevel)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)

	def onHPChanged(self, hp):
		"""
		Client method.(Avatar.def ClientMethods)
		"""
		DEBUG_MSG("bots Avatar.onHPChanged: %i" % hp)
		if hp > 0 and not self.aiMoving and self.cell is not None:
			# 受击即向最后雷达目标回击一次(近战贴脸状态)
			self.cell.reqAttack(self.lastTargetId)
