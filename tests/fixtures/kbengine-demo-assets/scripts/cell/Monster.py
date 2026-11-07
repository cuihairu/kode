# -*- coding: utf-8 -*-
import random
import time

import KBEngine
import monster_ai
from Avatar import Avatar
from KBEDebug import *
from DemoConsts import DEMO_GOLD_PER_KILL, DEMO_XP_PER_KILL


# def 侧 <Parent> Avatar 的脚本面镜像:引擎 checkDefMethod 要求父类 def 合并
# 进来的方法(respawn/onMove)在子类脚本类上可达,脚本继承让它们经 MRO 命中。
TIMER_THINK = 1


class Monster(Avatar):
	def __init__(self):
		KBEngine.Entity.__init__(self)
		# AI 态势面(引擎属性 aiState 在 Monster.def;ai* 成员为脚本私有态势)
		self.aiState = monster_ai.AI_IDLE
		self.aiHomePos = (self.position.x, self.position.y, self.position.z)
		self.aiTargetId = 0
		self.aiMoving = False
		self.aiLastAttackAt = 0.0
		self.aiRng = random.Random()
		self.addTimer(0.5, 0.5, TIMER_THINK)

	def onAggro(self, entityId):
		"""
		KBEngine method.
		仇恨目标变化
		"""
		DEBUG_MSG("Monster[%i].onAggro: %i" % (self.id, entityId))

	def onDamaged(self, attackerId):
		"""
		KBEngine method.(Monster.def CellMethods)
		受击反击:把攻击者立为仇恨目标(不受 AGGRO_RANGE 限制,下一 tick 追击)
		"""
		msg = "Monster[%i].onDamaged attacker=Avatar[%i] -> counter-aggro" % (self.id, attackerId)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		self.aiTargetId = attackerId

	def onMove(self, position, userData=None):
		"""
		interface ROLE.
		移动回调(接口混入方法,声明在 interfaces/ROLE.def,双参口径):
		引擎移动控制器逐 tick 回调同名 onMove(controllerId, userData)
		(entity.cpp:2936),checkDefMethod 要求脚本参数个数与 def 一致,
		故 def 与脚本统一双参——一份签名同时兼容接口形态与引擎回调形态。
		"""
		DEBUG_MSG("Monster[%i].onMove: %s" % (self.id, (position, userData)))

	def onMoveOver(self, controllerId, userarg):
		"""
		KBEngine method.(引擎 moveToPoint/moveToEntity 到点回调,entity.cpp:2948)
		"""
		self.aiMoving = False

	def onMoveFailure(self, controllerId, userarg):
		"""
		KBEngine method.(引擎移动失败回调:目标丢失等,清态势防呆转)
		"""
		self.aiMoving = False
		self.aiTargetId = 0

	def receiveDamage(self, damage, attackerId):
		"""
		KBEngine method.(覆写 Avatar.receiveDamage)
		受击三段:onDamaged 反击仇恨 → 父类扣血/死亡锚 → 死亡时给击杀者结算
		(金币进 Inventory 组件、经验走基座 cellAddExperience)后自毁。
		"""
		self.onDamaged(attackerId)
		Avatar.receiveDamage(self, damage, attackerId)
		if self.hp <= 0:
			# 击杀者须真是 Avatar 才有奖励面(怪物互杀/环境杀伤无 bag/基座经验面);
			# 无条件自毁——奖励分支异常不得吞掉 destroy,否则 hp=0 尸体滞留战场。
			killer = KBEngine.entities.get(attackerId)
			if killer is not None and getattr(killer, "className", "") == "Avatar":
				killer.bag.gold += DEMO_GOLD_PER_KILL
				killer.base.cellAddExperience(DEMO_XP_PER_KILL)
				msg = "Monster[%i] KILLED by Avatar[%i] reward gold+=%i exp+=%i" % (
					self.id, attackerId, DEMO_GOLD_PER_KILL, DEMO_XP_PER_KILL,
				)
				print("[demo-evidence] %s" % msg, flush=True)
				evidenceLog(msg)
			self.destroy()

	def think(self):
		"""测试模型补充(组合根验收):跨类调用父实体 Avatar 的方法(<Parent> Avatar 链)。"""
		self.respawn()

	def _pickTarget(self):
		"""态势采集:优先记忆的仇恨目标,否则 entitiesInRange 拾最近存活 Avatar。

		引擎取证修正:entitiesInRange(radius, entityType) 按 utype 匹配,
		def <Parent> 继承使 Monster 与 Avatar 同族命中(真机:无 Avatar 在场时
		怪物拾到彼此/自身并自相残杀)——必须再按 className 过滤敌我。
		"""
		if self.aiTargetId:
			e = KBEngine.entities.get(self.aiTargetId)
			if e is not None and getattr(e, "hp", 0) > 0:
				return e
			self.aiTargetId = 0
		best = None
		bestDist = None
		for e in self.entitiesInRange(monster_ai.AGGRO_RANGE, "Avatar"):
			if getattr(e, "className", "") != "Avatar":
				continue
			if getattr(e, "hp", 0) <= 0:
				continue
			d = monster_ai.dist(
				(self.position.x, self.position.y, self.position.z),
				(e.position.x, e.position.y, e.position.z),
			)
			if bestDist is None or d < bestDist:
				best, bestDist = e, d
		return best

	def _setState(self, newState):
		if newState == self.aiState:
			return
		msg = "Monster[%i] AI %s -> %s (pos=%.1f,%.1f,%.1f)" % (
			self.id,
			monster_ai.AI_STATE_NAMES.get(self.aiState, str(self.aiState)),
			monster_ai.AI_STATE_NAMES.get(newState, str(newState)),
			self.position.x, self.position.y, self.position.z,
		)
		print("[demo-evidence] %s" % msg, flush=True)
		evidenceLog(msg)
		self.aiState = newState

	def _moveToPoint(self, point, velocity):
		self.aiMoving = True
		self.moveToPoint(point, velocity, 0.0, None, True, False)

	def onTimer(self, timerID, userArg):
		"""
		KBEngine method.
		AI 心跳:态势采集 → 纯函数决策(monster_ai.decide)→ 动作执行
		"""
		if userArg != TIMER_THINK:
			return
		now = time.time()
		target = self._pickTarget()
		if target is not None:
			self.aiTargetId = target.id
			targetDist = monster_ai.dist(
				(self.position.x, self.position.y, self.position.z),
				(target.position.x, target.position.y, target.position.z),
			)
		else:
			targetDist = None
		distHome = monster_ai.dist(
			(self.position.x, self.position.y, self.position.z), self.aiHomePos
		)
		state, action = monster_ai.decide(
			self.aiState, targetDist, distHome, now - self.aiLastAttackAt
		)
		self._setState(state)

		if action == "wander":
			if not self.aiMoving:
				self._moveToPoint(
					monster_ai.choose_wander_point(self.aiHomePos, monster_ai.WANDER_RADIUS, self.aiRng),
					monster_ai.MOVE_VELOCITY,
				)
		elif action == "chase":
			if target is not None and not self.aiMoving:
				self.aiMoving = True
				self.moveToEntity(
					target.id, monster_ai.CHASE_VELOCITY, monster_ai.ATTACK_RANGE * 0.9, None, True, False
				)
		elif action == "attack":
			if target is not None:
				self.aiLastAttackAt = now
				target.receiveDamage(monster_ai.DEMO_DAMAGE, self.id)
				msg = "Monster[%i] ATTACK hit Avatar[%i] dmg=%i targetHp=%i" % (
					self.id, target.id, monster_ai.DEMO_DAMAGE, target.hp,
				)
				print("[demo-evidence] %s" % msg, flush=True)
				evidenceLog(msg)
		elif action == "return":
			if not self.aiMoving:
				self._moveToPoint(self.aiHomePos, monster_ai.MOVE_VELOCITY)
		# idle/hold:不动
