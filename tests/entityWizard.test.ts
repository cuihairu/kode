import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import {
  buildEntityDefContent,
  buildEntityPartContent,
  buildEntityPartPythonContent,
  buildFixedDictTypeDefinition,
  buildNewEntityDefContent,
  buildNewEntityRegistration,
  containerGuardProperties,
  entityWizardPartsToGenerate,
  fixedDictTypeName,
  resolveEntityWizardTemplateOverrides
} from '../src/entityWizard';

const baseInput = {
  name: 'Avatar',
  hasBase: true,
  hasCell: true,
  hasClient: true,
  generateClientStub: true,
  propertyTemplate: 'simple' as const
};

function hasPython3(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('GEN-DEF-2 def 骨架', () => {
  it('根/Parent/属性节点齐全', () => {
    const content = buildNewEntityDefContent({ ...baseInput, parent: 'BaseEntity' }, '2026-01-01T00:00:00.000Z');
    expect(content).toContain('<root>');
    expect(content).toContain('<Parent>');
    expect(content).toContain('<BaseEntity/>');
    expect(content).toContain('<Properties>');
    expect(content).toContain('<name>');
    expect(content).toContain('<hp>');
    expect(content).toContain('<position>');
    expect(content).toContain('<tempState>');
  });

  it('不含 Parent 时省略声明', () => {
    const content = buildNewEntityDefContent(baseInput, '2026-01-01T00:00:00.000Z');
    expect(content).not.toContain('<Parent>');
  });

  it('TEMP 属性带 Persistent=false(不持久化)', () => {
    const content = buildNewEntityDefContent(baseInput, '2026-01-01T00:00:00.000Z');
    const tempBlock = content.match(/<tempState>[\s\S]*?<\/tempState>/);
    expect(tempBlock).not.toBeNull();
    expect(tempBlock![0]).toContain('<Persistent> false </Persistent>');
  });

  it('属性模板:simple 内联 UINT32', () => {
    const content = buildNewEntityDefContent({ ...baseInput, propertyTemplate: 'simple' }, '2026-01-01T00:00:00.000Z');
    expect(content).toContain('<level>');
    expect(content).toContain('<Type> UINT32 </Type>');
    expect(content).not.toContain('ARRAY');
    expect(content).not.toContain('FIXED_DICT');
  });

  it('属性模板:fixedArray 内联 ARRAY<of>', () => {
    const content = buildNewEntityDefContent({ ...baseInput, propertyTemplate: 'fixedArray' }, '2026-01-01T00:00:00.000Z');
    const block = content.match(/<skillIds>[\s\S]*?<\/skillIds>/);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('ARRAY');
    expect(block![0]).toContain('<of> UINT32 </of>');
  });

  it('属性模板:fixedDict 引用 types.xml 命名类型', () => {
    const content = buildNewEntityDefContent({ ...baseInput, propertyTemplate: 'fixedDict' }, '2026-01-01T00:00:00.000Z');
    const block = content.match(/<state>[\s\S]*?<\/state>/);
    expect(block).not.toBeNull();
    expect(block![0]).toContain(`<Type> ${fixedDictTypeName('Avatar')} </Type>`);
  });

  it('标签配平(结构面自检)', () => {
    const content = buildNewEntityDefContent({ ...baseInput, propertyTemplate: 'fixedArray' }, '2026-01-01T00:00:00.000Z');
    for (const tag of ['root', 'Properties', 'name', 'hp', 'position', 'tempState', 'skillIds', 'Type', 'Flags']) {
      const opens = (content.match(new RegExp(`<${tag}(?=[\\s>])`, 'g')) ?? []).length;
      const closes = (content.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      expect(opens, `${tag} 开标签数`).toBe(closes);
    }
  });
});

describe('GEN-DEF-2 实体脚本(按引擎约定)', () => {
  it('类名=实体名(无 Cell/Base 后缀),继承 KBEngine.Entity', () => {
    for (const part of ['base', 'cell', 'client'] as const) {
      const content = buildEntityPartPythonContent(baseInput, part, '2026-01-01T00:00:00.000Z');
      expect(content).toContain('class Avatar(KBEngine.Entity):');
      expect(content).not.toContain('class AvatarCell');
      expect(content).not.toContain('class AvatarBase');
    }
  });

  it('__init__ 先调父类构造', () => {
    const content = buildEntityPartPythonContent(baseInput, 'base', '2026-01-01T00:00:00.000Z');
    const initBlock = content.match(/def __init__\(self\):[\s\S]*?(?=\n\tdef )/);
    expect(initBlock).not.toBeNull();
    expect(initBlock![0]).toContain('KBEngine.Entity.__init__(self)');
  });

  it('base 段有 onWriteToDB(self, cellData) 约定钩子', () => {
    const content = buildEntityPartPythonContent(baseInput, 'base', '2026-01-01T00:00:00.000Z');
    expect(content).toContain('def onWriteToDB(self, cellData):');
  });

  it('cell 段有 onEnterWorld/onLeaveWorld,base 段没有', () => {
    const cell = buildEntityPartPythonContent(baseInput, 'cell', '2026-01-01T00:00:00.000Z');
    const base = buildEntityPartPythonContent(baseInput, 'base', '2026-01-01T00:00:00.000Z');
    expect(cell).toContain('def onEnterWorld(self):');
    expect(cell).toContain('def onLeaveWorld(self):');
    expect(base).not.toContain('onEnterWorld');
  });

  it('client 段有 onClientEnabled', () => {
    const content = buildEntityPartPythonContent(baseInput, 'client', '2026-01-01T00:00:00.000Z');
    expect(content).toContain('def onClientEnabled(self):');
  });

  it('onTimer 钩子在每段(脚本钩子非 def 方法)', () => {
    for (const part of ['base', 'cell', 'client'] as const) {
      expect(buildEntityPartPythonContent(baseInput, part, '2026-01-01T00:00:00.000Z')).toContain(
        'def onTimer(self, id, userArg):'
      );
    }
  });
});

describe('GEN-DEF-2 None 守卫(GEN-DEF-1 口径)', () => {
  it('fixedArray:skillIds 守卫只在 base 段', () => {
    const input = { ...baseInput, propertyTemplate: 'fixedArray' as const };
    expect(containerGuardProperties(input, 'base')).toEqual([{ name: 'skillIds', empty: '[]' }]);
    expect(containerGuardProperties(input, 'cell')).toEqual([]);
    expect(containerGuardProperties(input, 'client')).toEqual([]);
    const base = buildEntityPartPythonContent(input, 'base', '2026-01-01T00:00:00.000Z');
    const cell = buildEntityPartPythonContent(input, 'cell', '2026-01-01T00:00:00.000Z');
    expect(base).toContain('if self.skillIds is None:');
    expect(base).toContain('self.skillIds = []');
    expect(cell).not.toContain('self.skillIds');
  });

  it('fixedDict:state 守卫只在 cell 段', () => {
    const input = { ...baseInput, propertyTemplate: 'fixedDict' as const };
    expect(containerGuardProperties(input, 'cell')).toEqual([{ name: 'state', empty: '{}' }]);
    expect(containerGuardProperties(input, 'base')).toEqual([]);
    const cell = buildEntityPartPythonContent(input, 'cell', '2026-01-01T00:00:00.000Z');
    expect(cell).toContain('if self.state is None:');
    expect(cell).toContain('self.state = {}');
  });

  it('simple:无守卫,且全仓无 `if not self.` 形态(口径)', () => {
    for (const part of ['base', 'cell', 'client'] as const) {
      const content = buildEntityPartPythonContent(baseInput, part, '2026-01-01T00:00:00.000Z');
      expect(content).not.toContain('if not self.');
      expect(content).not.toContain('if self.level');
    }
  });

  it('fixedArray/fixedDict 守卫用 is None 形态(非 not self.)', () => {
    const fa = buildEntityPartPythonContent({ ...baseInput, propertyTemplate: 'fixedArray' }, 'base', '2026-01-01T00:00:00.000Z');
    const fd = buildEntityPartPythonContent({ ...baseInput, propertyTemplate: 'fixedDict' }, 'cell', '2026-01-01T00:00:00.000Z');
    expect(fa).not.toContain('if not self.');
    expect(fd).not.toContain('if not self.');
  });
});

describe('GEN-DEF-2 客户端 stub 与注册', () => {
  it('partsToGenerate:client 仅在 hasClient 且 generateClientStub', () => {
    expect(entityWizardPartsToGenerate(baseInput)).toEqual(['base', 'cell', 'client']);
    expect(entityWizardPartsToGenerate({ ...baseInput, generateClientStub: false })).toEqual(['base', 'cell']);
    expect(entityWizardPartsToGenerate({ ...baseInput, hasClient: false })).toEqual(['base', 'cell']);
    expect(
      entityWizardPartsToGenerate({ ...baseInput, hasBase: false, hasCell: true, hasClient: true, generateClientStub: true })
    ).toEqual(['cell', 'client']);
  });

  it('注册片段带三态 hasX 属性(属性序 hasCell/hasBase/hasClient 与落盘一致)', () => {
    expect(buildNewEntityRegistration(baseInput)).toBe(
      '  <Avatar hasCell="true" hasBase="true" hasClient="true" />'
    );
    expect(
      buildNewEntityRegistration({ ...baseInput, hasBase: false, hasCell: false, hasClient: true })
    ).toBe('  <Avatar hasCell="false" hasBase="false" hasClient="true" />');
  });

  it('fixedDict 类型定义无 implementedBy(默认序列化可加载)', () => {
    const def = buildFixedDictTypeDefinition(baseInput);
    expect(def).toContain('<AvatarState>');
    expect(def).toContain('FIXED_DICT');
    expect(def).toContain('<value>');
    expect(def).not.toContain('implementedBy');
  });
});

describe('GEN-DEF-2 项目模板覆盖(.kode/templates/)', () => {
  it('readFile 全空 → 无覆盖', () => {
    const overrides = resolveEntityWizardTemplateOverrides('/ws', () => null);
    expect(overrides).toEqual({});
  });

  it('逐个文件读入 → 覆盖到位', () => {
    const store: Record<string, string> = {
      '/ws/.kode/templates/new-entity.def': 'DEF {{Name}}',
      '/ws/.kode/templates/new-entity.base.py': 'BASE {{ClassName}}',
      '/ws/.kode/templates/new-entity.cell.py': 'CELL {{Name}}',
      '/ws/.kode/templates/new-entity.client.py': 'CLIENT {{Name}}'
    };
    const overrides = resolveEntityWizardTemplateOverrides('/ws', p => store[p] ?? null);
    expect(overrides.def).toBe('DEF {{Name}}');
    expect(overrides.base).toBe('BASE {{ClassName}}');
    expect(overrides.cell).toBe('CELL {{Name}}');
    expect(overrides.client).toBe('CLIENT {{Name}}');
  });

  it('模板优先于内置,占位符替换,未知占位符保留', () => {
    const content = buildEntityDefContent(
      baseInput,
      { def: '// {{Name}} / {{ClassName}} / {{Unknown}}' },
      '2026-01-01T00:00:00.000Z'
    );
    expect(content).toBe('// Avatar / Avatar / {{Unknown}}');
  });

  it('buildEntityPartContent 模板优先,无覆盖走内置', () => {
    const overridden = buildEntityPartContent(baseInput, 'base', { base: 'BASE {{Name}}' }, '2026-01-01T00:00:00.000Z');
    expect(overridden).toBe('BASE Avatar');
    const builtin = buildEntityPartContent(baseInput, 'base', {}, '2026-01-01T00:00:00.000Z');
    expect(builtin).toContain('class Avatar(KBEngine.Entity):');
  });
});

describe('GEN-DEF-2 可加载性自检', () => {
  // 无语法错误(接受「可直接被引擎加载」):有 python3 时对生成脚本做 compile
  // 校验;无 python3(纯静态环境)则跳过,结构面自检仍兜底。
  const pythonOk = hasPython3();
  it('生成脚本可被 python3 编译(有解释器时)', () => {
    if (!pythonOk) {
      return;
    }
    const inputs = [
      { ...baseInput, propertyTemplate: 'simple' as const },
      { ...baseInput, propertyTemplate: 'fixedArray' as const },
      { ...baseInput, propertyTemplate: 'fixedDict' as const },
      { ...baseInput, hasBase: false, hasCell: false, hasClient: true, propertyTemplate: 'simple' as const }
    ];
    for (const input of inputs) {
      for (const part of ['base', 'cell', 'client'] as const) {
        const content = buildEntityPartPythonContent(input, part, '2026-01-01T00:00:00.000Z');
        expect(
          () =>
            execFileSync(
              'python3',
              ['-c', "import sys; compile(sys.stdin.read(), '<gen>', 'exec')"],
              { input: content, stdio: ['pipe', 'ignore', 'pipe'] }
            ),
          `${part} 段编译失败`
        ).not.toThrow();
      }
    }
  });

  it('结构面:每段恰好一个类定义,方法缩进一致', () => {
    for (const part of ['base', 'cell', 'client'] as const) {
      const content = buildEntityPartPythonContent(baseInput, part, '2026-01-01T00:00:00.000Z');
      const classes = (content.match(/^class .*:$/gm) ?? []).length;
      expect(classes).toBe(1);
      for (const line of content.split('\n')) {
        if (/^\tdef /.test(line) || /^\t\t/.test(line)) {
          expect(line, `缩进异常: ${line}`).toMatch(/^\t/);
        }
      }
    }
  });
});
