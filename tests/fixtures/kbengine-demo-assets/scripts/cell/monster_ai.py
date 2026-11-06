# -*- coding: utf-8 -*-
"""迷你 ARPG 怪物 AI 决策(纯函数,零 KBEngine import)。

DEMO-GAME-002:状态机决策面与执行面分离——本模块只做"给定态势 → 下一状态+动作",
可被 python3 单测直跑(vitest spawn),Monster(cell)只做态势采集与动作执行。
状态迁移表:
    IDLE   --看见 Avatar--> CHASE/ATTACK(IDLE 也兜底转 WANDER 游走)
    WANDER --看见 Avatar--> CHASE/ATTACK;否则保持游走
    CHASE  --目标丢失/出追击视野/越 leash--> RETURN;进入攻击距离 --> ATTACK
    ATTACK --目标丢失/越 leash--> RETURN;目标拉开 --> CHASE;冷却转好 --> 出手
    RETURN --重见 Avatar--> CHASE/ATTACK;到家 --> IDLE
"""
import math

# aiState 编码(Monster.def aiState UINT8,CELL_PUBLIC 供客户端观测)
AI_IDLE = 0
AI_WANDER = 1
AI_CHASE = 2
AI_ATTACK = 3
AI_RETURN = 4

AI_STATE_NAMES = {
    AI_IDLE: "IDLE",
    AI_WANDER: "WANDER",
    AI_CHASE: "CHASE",
    AI_ATTACK: "ATTACK",
    AI_RETURN: "RETURN",
}

# 态势阈值(格=引擎单位与出生点偏移同尺度)
AGGRO_RANGE = 12.0       # 仇恨拾取半径(entitiesInRange 精确 Avatar utype)
ATTACK_RANGE = 2.0       # 进入近身攻击的距离
ATTACK_DROP_RANGE = ATTACK_RANGE * 1.5   # 攻击态目标拉开即回落追击(滞回)
LEASH_RANGE = 30.0       # 离巢超过此距离强制脱战回巢
HOME_EPSILON = 0.5       # 回巢到位判定
WANDER_RADIUS = 8.0      # 巢点周围游走半径

MOVE_VELOCITY = 3.0       # 游走/回巢速度
CHASE_VELOCITY = 5.0      # 追击速度
ATTACK_PERIOD = 2.0       # 近身攻击冷却(秒)
DEMO_DAMAGE = 10          # 单次近身伤害(Avatar.hp UINT32)

ACTIONS = ("idle", "wander", "chase", "attack", "return", "hold")


def dist(a, b):
    """两点欧氏距离(a/b 为 (x,y,z) 三元组)。"""
    return math.sqrt(
        (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
    )


def choose_wander_point(home, radius, rng):
    """巢点周围半径 radius 内随机游走点(XZ 平面,高度沿用巢点)。rng=random 实例。"""
    angle = rng.uniform(0.0, math.pi * 2.0)
    r = rng.uniform(radius * 0.3, radius)
    return (
        home[0] + math.cos(angle) * r,
        home[1],
        home[2] + math.sin(angle) * r,
    )


def _engage(target_dist):
    """看见目标:进入攻击距离直接 ATTACK,否则 CHASE。"""
    if target_dist <= ATTACK_RANGE:
        return (AI_ATTACK, "attack")
    return (AI_CHASE, "chase")


def decide(state, target_dist, dist_home, since_attack):
    """纯决策:当前态 + 态势 → (下一状态, 动作)。

    state: AI_* 常量;target_dist: 最近存活 Avatar 距离(无目标 None);
    dist_home: 距巢距离;since_attack: 距上次出手秒数。
    动作 ∈ ACTIONS,由执行面(Monster.think)落地。
    """
    # 越 leash 一票否决:任何状态看见巢超界都回家
    if dist_home > LEASH_RANGE and state != AI_RETURN:
        return (AI_RETURN, "return")

    seen = target_dist is not None and target_dist <= AGGRO_RANGE

    if state == AI_IDLE:
        if seen:
            return _engage(target_dist)
        return (AI_WANDER, "wander")

    if state == AI_WANDER:
        if seen:
            return _engage(target_dist)
        return (AI_WANDER, "wander")

    if state == AI_CHASE:
        if target_dist is None:
            return (AI_RETURN, "return")
        if dist_home > LEASH_RANGE:
            return (AI_RETURN, "return")
        if target_dist <= ATTACK_RANGE:
            return (AI_ATTACK, "attack")
        return (AI_CHASE, "chase")

    if state == AI_ATTACK:
        if target_dist is None:
            return (AI_RETURN, "return")
        if dist_home > LEASH_RANGE:
            return (AI_RETURN, "return")
        if target_dist > ATTACK_DROP_RANGE:
            return (AI_CHASE, "chase")
        if since_attack >= ATTACK_PERIOD:
            return (AI_ATTACK, "attack")
        return (AI_ATTACK, "hold")

    if state == AI_RETURN:
        if seen:
            return _engage(target_dist)
        if dist_home <= HOME_EPSILON:
            return (AI_IDLE, "idle")
        return (AI_RETURN, "return")

    # 未知状态兜底回 IDLE
    return (AI_IDLE, "idle")
