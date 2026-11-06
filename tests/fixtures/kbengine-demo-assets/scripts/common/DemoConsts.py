# -*- coding: utf-8 -*-
"""迷你 ARPG 战斗常数(DEMO-GAME-003):base/cell 两脚本面共用,放 common 避免跨目录互导。"""

# Avatar 攻击面
DEMO_ATTACK_RANGE = 3.5      # 攻击距离(Monster 近身 2 < 3.5,站桩可反打)
DEMO_AVATAR_DAMAGE = 15      # Avatar 单次攻击伤害
DEMO_ATTACK_COOLDOWN = 1.5   # 攻击冷却(秒)
DEMO_LEVEL_UP_STEP = 50      # 每 50 点经验升 1 级

# Avatar 死亡重生
DEMO_RESPAWN_DELAY = 5.0     # 倒地后回出生点满血重生的延时(秒)

# 击杀奖励(Monster 死亡 → 击杀者)
DEMO_GOLD_PER_KILL = 10      # 金币(Inventory 组件 gold)
DEMO_XP_PER_KILL = 30        # 经验(基座 experience)
