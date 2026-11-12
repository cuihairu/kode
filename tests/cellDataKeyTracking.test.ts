/**
 * KSEM-CELL-09:cellData 脚本附加键跟踪(纯模块面)。
 * 四类键:declared(def 字段/组件槽)/builtin(引擎内建)/scriptAdded(脚本
 * 显式写入的新键)/unknown(只读未写未知键);操作点存在性三态:
 * - write 恒 present;read/get 走最近写/删 walk(伪删 pop('字面量')/clear()
 *   与真实下标 del 同流);都无 → 初始状态:declared/builtin=present,
 *   scriptAdded=unknown(调用序不可证,事实带 introducedLine),
 *   unknown=封闭世界 absent/开放世界 unknown;
 * - 开放世界:动态键下标写(键非整段字面量)、update(/setdefault(;引号
 *   开头的非整段字面量键('a'+'b')也算;
 * - 合法新增键不误报:写即 scriptAdded,后续读不断 absent;
 * - 别名:无效别名(重绑定)操作整条剔除;逃逸后 read=unknown;
 * - 删除面:下标 del / pop('hp') / clear() 后读=absent;removedAfterWrite。
 */
import { describe, expect, it } from 'vitest';
import { trackCellDataKeys } from '../src/backend/cellDataKeyTracking';
import type { CellDataKeyEntry } from '../src/backend/cellDataCompletion';

/** 测试键宇宙条目(缺省 def 字段)。 */
function entry(key: string, typeLabel = 'UINT8', extra?: Partial<CellDataKeyEntry>): CellDataKeyEntry {
  return { key, kind: 'defField', typeLabel, sourceFile: 'Avatar.def', sourceLine: 5, ...extra };
}

/** 包一层类/方法体(体行 8 空格缩进)。 */
function wrap(...body: string[]): string {
  return ['class Avatar:', '    def on_spawn(self):', ...body.map(l => `        ${l}`)].join('\n');
}

describe('cellDataKeyTracking 四类键', () => {
  it('宇宙 def 字段 → declared,entry 随带;无操作不出事实', () => {
    const facts = trackCellDataKeys(wrap('hp = self.cellData["hp"]'), [entry('hp')]);
    expect(facts).toHaveLength(1);
    expect(facts[0].keyClass).toBe('declared');
    expect(facts[0].entry).toEqual(entry('hp'));
    expect(facts[0].introducedLine).toBeNull();
  });

  it('内建键 → builtin;组件槽 → declared', () => {
    const universe = [entry('position', 'VECTOR3', { kind: 'builtin' }), entry('bag', 'ARRAY', { kind: 'componentSlot' })];
    const facts = trackCellDataKeys(
      wrap('p = self.cellData["position"]', 'b = self.cellData["bag"]'),
      universe
    );
    expect(facts.map(f => f.keyClass)).toEqual(['builtin', 'declared']);
    expect(facts[0].entry?.kind).toBe('builtin');
  });

  it('未知键只读 → unknown;封闭世界读=absent', () => {
    const facts = trackCellDataKeys(wrap('x = self.cellData["nope"]'), [entry('hp')]);
    expect(facts[0].keyClass).toBe('unknown');
    expect(facts[0].entry).toBeNull();
    expect(facts[0].presence).toBe('absent');
  });

  it('显式新增键 → scriptAdded:写点 present、后续读 present,合法代码不误报', () => {
    const facts = trackCellDataKeys(
      wrap(
        'self.cellData["combo"] = 0',
        'c = self.cellData["combo"]'
      ),
      [entry('hp')]
    );
    expect(facts).toHaveLength(2);
    expect(facts[0].keyClass).toBe('scriptAdded');
    expect(facts[0].presence).toBe('present');
    expect(facts[1].keyClass).toBe('scriptAdded');
    expect(facts[1].presence).toBe('present');
    expect(facts[0].introducedLine).toBe(2);
  });

  it('宇宙键被脚本重写仍是 declared(写不改类,存在性走 walk)', () => {
    const facts = trackCellDataKeys(
      wrap('self.cellData["hp"] = 5', 'h = self.cellData["hp"]'),
      [entry('hp')]
    );
    expect(facts.every(f => f.keyClass === 'declared')).toBe(true);
    expect(facts.every(f => f.presence === 'present')).toBe(true);
  });
});

describe('cellDataKeyTracking 存在性 walk', () => {
  it('同域写前读:scriptAdded 初始 unknown(保守);写后删→后续读 absent', () => {
    const facts = trackCellDataKeys(
      wrap(
        'early = self.cellData["combo"]',
        'self.cellData["combo"] = 0',
        'del self.cellData["combo"]',
        'late = self.cellData["combo"]'
      ),
      []
    );
    expect(facts[0].presence).toBe('unknown'); // 引入行在其后,不硬断
    expect(facts[0].introducedLine).toBe(3);
    expect(facts[1].presence).toBe('present');
    expect(facts[2].presence).toBe('present'); // del 执行前状态:上一行刚写
    expect(facts[3].presence).toBe('absent');
    expect(facts[3].removedAfterWrite).toBe(true);
  });

  it('pop(\'字面量\') 是伪删:之后读 declared 键 = absent,之前 = present', () => {
    const facts = trackCellDataKeys(
      wrap(
        'a = self.cellData["hp"]',
        'self.cellData.pop("hp")',
        'b = self.cellData["hp"]'
      ),
      [entry('hp')]
    );
    expect(facts[0].presence).toBe('present');
    expect(facts[1].presence).toBe('absent');
    expect(facts[1].removedAfterWrite).toBe(false); // declared:从未脚本写入
  });

  it('clear() 后宇宙键与已引入键都走删证据', () => {
    const facts = trackCellDataKeys(
      wrap(
        'self.cellData["combo"] = 1',
        'self.cellData.clear()',
        'a = self.cellData["hp"]',
        'b = self.cellData["combo"]'
      ),
      [entry('hp')]
    );
    expect(facts[1].presence).toBe('absent');
    expect(facts[2].presence).toBe('absent');
  });

  it('跨作用域:方法 A 写、方法 B 读 → scriptAdded unknown(调用序不可证)', () => {
    const text = [
      'class Avatar:',
      '    def make(self):',
      '        self.cellData["combo"] = 0',
      '    def use(self):',
      '        c = self.cellData["combo"]'
    ].join('\n');
    const facts = trackCellDataKeys(text, []);
    expect(facts[0].keyClass).toBe('scriptAdded');
    expect(facts[1].presence).toBe('unknown');
  });

  it('常量键写也计数(k="combo" 后 self.cellData[k]=0)', () => {
    const facts = trackCellDataKeys(
      wrap('k = "combo"', 'self.cellData[k] = 0', 'c = self.cellData["combo"]'),
      []
    );
    expect(facts.every(f => f.keyClass === 'scriptAdded')).toBe(true);
    expect(facts[1].presence).toBe('present');
  });
});

describe('cellDataKeyTracking 开放世界', () => {
  it('动态键写(self.cellData[k] = v)→ unknown 键读不断 absent', () => {
    const facts = trackCellDataKeys(
      wrap('self.cellData[k] = 1', 'x = self.cellData["myst"]'),
      []
    );
    expect(facts[0].keyClass).toBe('unknown'); // 动态写不入 ops,只把世界打开放
    expect(facts[0].presence).toBe('unknown');
  });

  it('update(/setdefault( 算开放面', () => {
    for (const line of ['self.cellData.update(other)', 'self.cellData.setdefault("x", 1)']) {
      const facts = trackCellDataKeys(wrap(line, 'x = self.cellData["myst"]'), []);
      expect(facts[0].presence, line).toBe('unknown');
    }
  });

  it('引号开头但非整段字面量(\'a\' + \'b\')也算开放面', () => {
    const facts = trackCellDataKeys(
      wrap(`self.cellData['a' + 'b'] = 1`, 'x = self.cellData["myst"]'),
      []
    );
    expect(facts[0].presence).toBe('unknown');
  });

  it('封闭世界(只有字面量写)未知键读 = absent', () => {
    const facts = trackCellDataKeys(
      wrap('self.cellData["combo"] = 1', 'x = self.cellData["myst"]'),
      []
    );
    expect(facts[1].presence).toBe('absent');
  });

  it('注释里的伪动态写不算开放面', () => {
    const facts = trackCellDataKeys(
      wrap('# self.cellData[k] = 1', 'x = self.cellData["myst"]'),
      []
    );
    expect(facts[0].presence).toBe('absent');
  });
});

describe('cellDataKeyTracking 别名面', () => {
  it('有效别名写入引入 scriptAdded;别名读存在性走同一 walk', () => {
    const facts = trackCellDataKeys(
      wrap(
        'data = self.cellData',
        'data["combo"] = 0',
        'c = data["combo"]'
      ),
      []
    );
    expect(facts.every(f => f.keyClass === 'scriptAdded')).toBe(true);
    expect(facts[0].presence).toBe('present');
    expect(facts[1].presence).toBe('present');
    expect(facts[0].introducedLine).toBe(3);
  });

  it('重绑定后的别名操作整条剔除(不出事实)', () => {
    const facts = trackCellDataKeys(
      wrap(
        'data = self.cellData',
        'data = {}',
        'data["combo"] = 0',
        'c = data["combo"]'
      ),
      []
    );
    expect(facts).toHaveLength(0);
  });

  it('别名逃逸后 read=unknown', () => {
    const facts = trackCellDataKeys(
      wrap(
        'data = self.cellData',
        'leak(data)',
        'c = data["hp"]'
      ),
      [entry('hp')]
    );
    expect(facts[0].keyClass).toBe('declared');
    expect(facts[0].presence).toBe('unknown');
  });

  it('逃逸先于写、写晚于逃逸:walk 取写点存在', () => {
    const facts = trackCellDataKeys(
      wrap(
        'data = self.cellData',
        'leak(data)',
        'data["combo"] = 0',
        'c = data["combo"]'
      ),
      []
    );
    expect(facts[1].presence).toBe('present'); // 写晚于逃逸,证据恢复
  });
});
