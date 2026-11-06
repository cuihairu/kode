import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

// DEMO-GAME-002:怪物 AI 状态机。决策面是纯函数(scripts/cell/monster_ai.py,
// 零 KBEngine import),执行面在 scripts/cell/Monster.py(态势采集 + 动作落地)。
// 本文件两层锁:①夹具内容契约(正则);②python3 直跑纯函数迁移表(spawn 真执行,
// 前例见 buildProblemMatcher.test.ts 的 python3 spawnSync)。
const ASSETS = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');
const CELL_DIR = path.join(ASSETS, 'scripts', 'cell');
const p = (...parts: string[]) => path.join(ASSETS, ...parts);
const read = (...parts: string[]) => fs.readFileSync(p(...parts), 'utf8');

describe('DEMO-GAME-002 怪物 AI(夹具内容契约)', () => {
  it('monster_ai.py 纯决策:零 KBEngine import,状态/阈值/动作常量齐备', () => {
    const src = read('scripts', 'cell', 'monster_ai.py');
    expect(src).not.toMatch(/import\s+KBEngine/);
    expect(src).toMatch(/AI_IDLE\s*=\s*0/);
    expect(src).toMatch(/AI_WANDER\s*=\s*1/);
    expect(src).toMatch(/AI_CHASE\s*=\s*2/);
    expect(src).toMatch(/AI_ATTACK\s*=\s*3/);
    expect(src).toMatch(/AI_RETURN\s*=\s*4/);
    expect(src).toMatch(/AGGRO_RANGE\s*=\s*[\d.]+/);
    expect(src).toMatch(/ATTACK_RANGE\s*=\s*[\d.]+/);
    expect(src).toMatch(/ATTACK_DROP_RANGE\s*=\s*ATTACK_RANGE\s*\*\s*[\d.]+/);
    expect(src).toMatch(/LEASH_RANGE\s*=\s*[\d.]+/);
    expect(src).toMatch(/ATTACK_PERIOD\s*=\s*[\d.]+/);
    expect(src).toMatch(/def\s+decide\(/);
    expect(src).toMatch(/def\s+choose_wander_point\(/);
    expect(src).toMatch(/def\s+dist\(/);
  });

  it('Monster.py:决策/执行分离(think 心跳调 monster_ai.decide,不内联决策)', () => {
    const src = read('scripts', 'cell', 'Monster.py');
    expect(src).toMatch(/import\s+monster_ai/);
    expect(src).toMatch(/monster_ai\.decide\(/);
    expect(src).toMatch(/monster_ai\.choose_wander_point\(/);
    // 仇恨拾取:self.entitiesInRange 精确 "Avatar"(实体方法,引擎 utype 精确匹配,不自相仇恨)
    expect(src).toMatch(/self\.entitiesInRange\([^)]*,\s*"Avatar"\s*\)/);
    // 追击:moveToEntity;游走/回巢:moveToPoint(引擎 API,entity.cpp:2796/2858)
    expect(src).toMatch(/moveToEntity\(/);
    expect(src).toMatch(/moveToPoint\(/);
    // 到点/失败回调清 moving(entity.cpp:2948/2966 回调)
    expect(src).toMatch(/def\s+onMoveOver\(/);
    expect(src).toMatch(/def\s+onMoveFailure\(/);
    // 状态迁移与出手都走 evidenceLog 落文件锚
    expect(src).toMatch(/def\s+_setState[\s\S]*evidenceLog\(msg\)/);
    expect(src).toMatch(/ATTACK hit Avatar/);
    expect(src).toMatch(/def\s+onDamaged\(/);
  });

  it('伤害面:Avatar.def receiveDamage(CellMethods) ↔ cell/Avatar.py 实现', () => {
    const def = read('scripts', 'entity_defs', 'Avatar.def');
    expect(def).toMatch(/<receiveDamage>\s*<Arg>\s*UINT32\s*<\/Arg>\s*<Arg>\s*UINT32\s*<\/Arg>\s*<\/receiveDamage>/);
    const cell = read('scripts', 'cell', 'Avatar.py');
    expect(cell).toMatch(/def\s+receiveDamage\(self,\s*damage,\s*attackerId\)/);
    expect(cell).toMatch(/receiveDamage[\s\S]*evidenceLog\(msg\)/);
    // Monster.def onDamaged 反击入口
    const mdef = read('scripts', 'entity_defs', 'Monster.def');
    expect(mdef).toMatch(/<onDamaged>\s*<Arg>\s*UINT32\s*<\/Arg>\s*<\/onDamaged>/);
  });
});

describe('DEMO-GAME-002 怪物 AI(纯函数迁移表,python3 直跑)', () => {
  const runAi = (expr: string): { stdout: string; status: number } => {
    const code = [
      'import json, sys, random',
      'sys.dont_write_bytecode = True', // 导入夹具纯函数模块不留 __pycache__
      `sys.path.insert(0, ${JSON.stringify(CELL_DIR)})`,
      'import monster_ai',
      `print(json.dumps(${expr}))`,
    ].join('\n');
    const res = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    return { stdout: res.stdout.trim(), status: res.status };
  };
  const ai = (expr: string): unknown => JSON.parse(runAi(expr).stdout) as unknown;

  it('模块可导入且动作面封闭', () => {
    expect(ai('monster_ai.ACTIONS')).toEqual([
      'idle', 'wander', 'chase', 'attack', 'return', 'hold',
    ]);
  });

  it('IDLE/WANDER:见目标→CHASE(远)/ATTACK(近),不见→游走', () => {
    expect(ai('monster_ai.decide(monster_ai.AI_IDLE, None, 0.0, 0.0)')).toEqual([
      monster_aiEnum('WANDER'), 'wander',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_IDLE, 30.0, 0.0, 0.0)')).toEqual([
      monster_aiEnum('WANDER'), 'wander',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_IDLE, monster_ai.AGGRO_RANGE - 1, 0.0, 0.0)')).toEqual([
      monster_aiEnum('CHASE'), 'chase',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_WANDER, monster_ai.ATTACK_RANGE - 0.1, 0.0, 0.0)')).toEqual([
      monster_aiEnum('ATTACK'), 'attack',
    ]);
  });

  it('CHASE:进攻击距离→ATTACK;目标丢失→RETURN', () => {
    expect(ai('monster_ai.decide(monster_ai.AI_CHASE, monster_ai.ATTACK_RANGE - 0.1, 5.0, 99.0)')).toEqual([
      monster_aiEnum('ATTACK'), 'attack',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_CHASE, monster_ai.ATTACK_RANGE + 1, 5.0, 99.0)')).toEqual([
      monster_aiEnum('CHASE'), 'chase',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_CHASE, None, 5.0, 0.0)')).toEqual([
      monster_aiEnum('RETURN'), 'return',
    ]);
  });

  it('ATTACK:冷却转好出手,未转好保持;目标拉开(滞回)→CHASE', () => {
    expect(ai('monster_ai.decide(monster_ai.AI_ATTACK, monster_ai.ATTACK_RANGE, 5.0, monster_ai.ATTACK_PERIOD)')).toEqual([
      monster_aiEnum('ATTACK'), 'attack',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_ATTACK, monster_ai.ATTACK_RANGE, 5.0, monster_ai.ATTACK_PERIOD - 0.1)')).toEqual([
      monster_aiEnum('ATTACK'), 'hold',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_ATTACK, monster_ai.ATTACK_DROP_RANGE + 0.1, 5.0, 0.0)')).toEqual([
      monster_aiEnum('CHASE'), 'chase',
    ]);
  });

  it('leash 脱战:任何状态越界一律 RETURN;RETURN 到家→IDLE,重见目标→接战', () => {
    for (const st of ['AI_IDLE', 'AI_WANDER', 'AI_CHASE', 'AI_ATTACK']) {
      expect(ai(`monster_ai.decide(monster_ai.${st}, 1.0, monster_ai.LEASH_RANGE + 1, 0.0)`)).toEqual([
        monster_aiEnum('RETURN'), 'return',
      ]);
    }
    expect(ai('monster_ai.decide(monster_ai.AI_RETURN, None, monster_ai.HOME_EPSILON, 0.0)')).toEqual([
      monster_aiEnum('IDLE'), 'idle',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_RETURN, None, monster_ai.HOME_EPSILON * 2, 0.0)')).toEqual([
      monster_aiEnum('RETURN'), 'return',
    ]);
    expect(ai('monster_ai.decide(monster_ai.AI_RETURN, monster_ai.ATTACK_RANGE - 0.1, 5.0, 0.0)')).toEqual([
      monster_aiEnum('ATTACK'), 'attack',
    ]);
  });

  it('choose_wander_point 落在巢点 radius 内(XZ),高度沿用巢点', () => {
    const pts = ai(
      '[monster_ai.choose_wander_point((0.0, 1.0, 0.0), 8.0, random.Random(i)) for i in range(64)]'
    ) as Array<[number, number, number]>;
    expect(pts).toHaveLength(64);
    for (const [x, y, z] of pts) {
      expect(y).toBe(1.0);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(8.0 + 1e-9);
      expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(8.0 * 0.3 - 1e-9);
    }
  });

  it('dist 欧氏距离', () => {
    expect(ai('monster_ai.dist((0.0, 0.0, 0.0), (3.0, 4.0, 0.0))')).toBe(5.0);
  });
});

/** monster_ai.AI_* 名字 → 数值(测试读源解析,不重复硬编码) */
function monster_aiEnum(name: string): number {
  const src = fs.readFileSync(path.join(CELL_DIR, 'monster_ai.py'), 'utf8');
  const m = src.match(new RegExp(`AI_${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`AI_${name} not found`);
  return Number(m[1]);
}
