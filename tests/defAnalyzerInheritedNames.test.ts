import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeDefDocument,
  collectInheritedNames,
  type DefAnalysisFinding
} from '../src/defAnalyzer';

// 批116 继承链同名检查(inherited-name-collision)测试。引擎判重语义:
// 父子/接口描述装入同一 ScriptDefModule(entitydef.cpp loadDefInfo),同名
// 冲突按模块全局拒绝——属性/组件槽按域位相交判重(异域位同名可共存),
// 方法↔属性/组件全局拒绝,方法↔方法仅同段拒绝,组件槽↔任何同名无条件拒绝。
// 夹具用 mkdtemp 真盘树(findEntityDefsRootFromFile 走 fs.existsSync);
// Linux 大小写敏感,<Parent>Monster</Parent> 对应 Monster.def(与引擎
// loadParentClass 的 `defFilePath + parentClassName + ".def"` 同径)。

const writeTree = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-def-inherited-'));
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
};

const entityDef = (body: string): string => ['<root>', body, '</root>'].join('\n');

const prop = (name: string, flags: string, type = 'INT32'): string =>
  [
    '  <Properties>',
    `    <${name}>`,
    `      <Type>${type}</Type>`,
    `      <Flags>${flags}</Flags>`,
    `    </${name}>`,
    '  </Properties>'
  ].join('\n');

const method = (section: string, name: string): string =>
  [`  <${section}>`, `    <${name}>`, '    </' + `${name}>`, `  </${section}>`].join('\n');

const component = (name: string, flags?: string): string =>
  [
    '  <Components>',
    `    <${name}>`,
    ...(flags ? [`      <Flags>${flags}</Flags>`] : []),
    `    </${name}>`,
    '  </Components>'
  ].join('\n');

const parentTag = (name: string): string => `  <Parent>${name}</Parent>`;

const interfacesTag = (...names: string[]): string =>
  ['  <Interfaces>', ...names.map(name => `    <interface>${name}</interface>`), '  </Interfaces>'].join('\n');

const inheritedOf = (findings: DefAnalysisFinding[]): DefAnalysisFinding[] =>
  findings.filter(item => item.check === 'inherited-name-collision');

const firstInherited = (findings: DefAnalysisFinding[]): DefAnalysisFinding => {
  const hit = inheritedOf(findings);
  if (hit.length === 0) {
    throw new Error(`未找到 inherited-name-collision 建议: ${JSON.stringify(findings)}`);
  }
  return hit[0];
};

const trees: string[] = [];
const tree = (files: Record<string, string>): string => {
  const root = writeTree(files);
  trees.push(root);
  return root;
};

/** 写树 + 对 entry.def 跑「收集闭包 → analyze」的完整链路 */
const analyzeEntry = (files: Record<string, string>, entry: string): DefAnalysisFinding[] => {
  const root = tree(files);
  const entryPath = path.join(root, entry);
  return analyzeDefDocument(fs.readFileSync(entryPath, 'utf8'), collectInheritedNames(entryPath));
};

afterAll(() => {
  for (const root of trees) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('继承链同名:属性 vs 祖先属性(域位判重)', () => {
  it('父属性同域位同名报 error 并注明来源', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + prop('hp', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    const hit = firstInherited(findings);
    expect(hit.severity).toBe('error');
    expect(hit.name).toBe('hp');
    expect(hit.message).toContain('同域位同名');
    expect(hit.message).toContain('继承自 Monster.def');
  });

  it('父属性异域位同名不报(引擎允许共存)', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + prop('hp', 'BASE'))
      },
      'entity_defs/Child.def'
    );
    expect(inheritedOf(findings)).toEqual([]);
  });

  it('CELL 别名归一到 CELL_PUBLIC 后按同域位判重', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + prop('hp', 'CELL'))
      },
      'entity_defs/Child.def'
    );
    expect(firstInherited(findings).name).toBe('hp');
  });

  it('祖先属性旗标无法识别或缺 <Flags> 时域位为空,不误报', () => {
    // ANY_CLIENTS 引擎未注册(域位解析不到),无 <Flags> 节点同样得空域位
    const files = {
      'entities.xml': '<root></root>',
      'entity_defs/PhantomFlag.def': entityDef(
        `<Properties>\n    <hp>\n      <Type>INT32</Type>\n      <Flags>ANY_CLIENTS</Flags>\n    </hp>\n  </Properties>`
      ),
      'entity_defs/NoFlags.def': entityDef(
        `<Properties>\n    <hp>\n      <Type>INT32</Type>\n    </hp>\n  </Properties>`
      ),
      'entity_defs/ChildA.def': entityDef(parentTag('PhantomFlag') + prop('hp', 'CELL_PUBLIC')),
      'entity_defs/ChildB.def': entityDef(parentTag('NoFlags') + prop('hp', 'CELL_PUBLIC'))
    };
    expect(inheritedOf(analyzeEntry(files, 'entity_defs/ChildA.def'))).toEqual([]);
    expect(inheritedOf(analyzeEntry(files, 'entity_defs/ChildB.def'))).toEqual([]);
  });

  it('祖父链传递:同名属性经两级 Parent 仍报', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Grandparent.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Monster.def': entityDef(parentTag('Grandparent') + prop('mp', 'BASE')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + prop('hp', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    expect(firstInherited(findings).name).toBe('hp');
  });
});

describe('继承链同名:方法↔属性/组件(全局拒绝)', () => {
  it('父方法 vs 子属性同名报 error', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(method('BaseMethods', 'kill')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + prop('kill', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    const hit = firstInherited(findings);
    expect(hit.message).toContain('与继承链上的方法同名');
    expect(hit.message).toContain('继承自 Monster.def');
  });

  it('父属性 vs 子方法同名报 error', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + method('BaseMethods', 'hp'))
      },
      'entity_defs/Child.def'
    );
    const hit = firstInherited(findings);
    expect(hit.message).toContain('与继承链上的属性/组件同名');
  });

  it('父 base 方法 vs 子 cell 方法同名不报(异段可共存)', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(method('BaseMethods', 'onMove')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + method('CellMethods', 'onMove'))
      },
      'entity_defs/Child.def'
    );
    expect(inheritedOf(findings)).toEqual([]);
  });

  it('父 base 方法 vs 子 base 方法同名报 error', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(method('BaseMethods', 'onMove')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + method('BaseMethods', 'onMove'))
      },
      'entity_defs/Child.def'
    );
    const hit = firstInherited(findings);
    expect(hit.message).toContain('同段同名');
  });

  it('ClientMethods 段:同段报,异段(祖先 client vs 子 base)不报', () => {
    const files = {
      'entities.xml': '<root></root>',
      'entity_defs/ClientMaster.def': entityDef(
        method('ClientMethods', 'ping') + '\n' + method('CellMethods', 'swipe')
      ),
      'entity_defs/Same.def': entityDef(parentTag('ClientMaster') + method('ClientMethods', 'ping')),
      'entity_defs/Diff.def': entityDef(parentTag('ClientMaster') + method('BaseMethods', 'ping'))
    };
    const hit = firstInherited(analyzeEntry(files, 'entity_defs/Same.def'));
    expect(hit.message).toContain('同段同名');
    expect(inheritedOf(analyzeEntry(files, 'entity_defs/Diff.def'))).toEqual([]);
  });
});

describe('继承链同名:接口混入与组件槽', () => {
  it('接口混入属性同名报 error', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/interfaces/Iface.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(interfacesTag('Iface') + prop('hp', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    expect(firstInherited(findings).name).toBe('hp');
  });

  it('接口文件自身的 <Parent> 不产生边(引擎 loadInterfaces 不走 loadParentClass)', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Grandparent.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/interfaces/Iface.def': entityDef(parentTag('Grandparent') + prop('mp', 'BASE')),
        'entity_defs/Child.def': entityDef(interfacesTag('Iface') + prop('hp', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    expect(inheritedOf(findings)).toEqual([]);
  });

  it('组件槽 vs 父属性异域位同名仍报(组件槽无条件判重)', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + component('hp'))
      },
      'entity_defs/Child.def'
    );
    const hit = firstInherited(findings);
    expect(hit.message).toContain('组件槽');
  });

  it('组件槽 vs 父组件槽同名报 error(父组件槽带 Flags,域位入面)', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(component('gun', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(parentTag('Monster') + component('gun', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    expect(firstInherited(findings).name).toBe('gun');
  });

  it('组件 def 的 Parent 在 components/ 内解析', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/components/Base.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/components/Comp.def': entityDef(parentTag('Base') + prop('hp', 'CELL_PUBLIC'))
      },
      'entity_defs/components/Comp.def'
    );
    expect(firstInherited(findings).name).toBe('hp');
  });
});

describe('继承链同名:闭包边界与健壮性', () => {
  it('Parent 环不挂死且双向报', () => {
    const files = {
      'entities.xml': '<root></root>',
      'entity_defs/A.def': entityDef(parentTag('B') + prop('hp', 'CELL_PUBLIC')),
      'entity_defs/B.def': entityDef(parentTag('A') + prop('hp', 'CELL_PUBLIC'))
    };
    const findingsA = analyzeEntry(files, 'entity_defs/A.def');
    const findingsB = analyzeEntry(files, 'entity_defs/B.def');
    expect(firstInherited(findingsA).message).toContain('继承自 B.def');
    expect(firstInherited(findingsB).message).toContain('继承自 A.def');
  });

  it('悬空 Parent 不产生边、无 finding', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Child.def': entityDef(parentTag('Missing') + prop('hp', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    expect(inheritedOf(findings)).toEqual([]);
  });

  it('祖先文件畸形或空文档时跳过,不崩不误报', () => {
    // Monster 挂一个畸形祖先(Broken,解析抛错)与一个空文档接口(Empty,
    // 无根):两级都被闭包访问到,各自跳过,不影响正常祖先面的聚合
    const childDef = entityDef(parentTag('Monster') + prop('hp', 'CELL_PUBLIC'));
    const monsterDef = entityDef(
      parentTag('Broken') + interfacesTag('Empty') + prop('hp', 'CELL_PUBLIC')
    );
    const root = tree({
      'entities.xml': '<root></root>',
      'entity_defs/Broken.def': '<root><Properties><hp>',
      'entity_defs/interfaces/Empty.def': '   ',
      'entity_defs/Monster.def': monsterDef,
      'entity_defs/Child.def': childDef
    });
    const findings = analyzeDefDocument(
      childDef,
      collectInheritedNames(path.join(root, 'entity_defs/Child.def'))
    );
    const hit = firstInherited(findings);
    expect(hit.name).toBe('hp');
    expect(hit.message).toContain('Monster.def');
    expect(hit.message).not.toContain('Broken.def');
    expect(hit.message).not.toContain('Empty.def');
  });

  it('无 entities.xml 时定义根定位不到,闭包为空面', () => {
    const root = tree({
      'plain/child.def': entityDef(parentTag('parent') + prop('hp', 'CELL_PUBLIC')),
      'plain/parent.def': entityDef(prop('hp', 'CELL_PUBLIC'))
    });
    const inherited = collectInheritedNames(path.join(root, 'plain/child.def'));
    expect(inherited.size).toBe(0);
    const findings = analyzeDefDocument(
      fs.readFileSync(path.join(root, 'plain/child.def'), 'utf8'),
      inherited
    );
    expect(inheritedOf(findings)).toEqual([]);
  });

  it('readText 全 null 时闭包为空面(不虚构祖先)', () => {
    const root = tree({
      'entities.xml': '<root></root>',
      'entity_defs/Monster.def': entityDef(prop('hp', 'CELL_PUBLIC')),
      'entity_defs/Child.def': entityDef(parentTag('Monster') + prop('hp', 'CELL_PUBLIC'))
    });
    const findings = analyzeDefDocument(
      fs.readFileSync(path.join(root, 'entity_defs/Child.def'), 'utf8'),
      collectInheritedNames(path.join(root, 'entity_defs/Child.def'), () => null)
    );
    expect(inheritedOf(findings)).toEqual([]);
  });

  it('多祖先同名聚合:来源列出全部命中祖先', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/interfaces/A.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/interfaces/B.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(interfacesTag('A', 'B') + prop('hp', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    const hit = firstInherited(findings);
    expect(hit.message).toContain('A.def');
    expect(hit.message).toContain('B.def');
  });

  it('同名命中超 3 个祖先时来源列表截断到 3 个', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/interfaces/A.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/interfaces/B.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/interfaces/C.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/interfaces/D.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(interfacesTag('A', 'B', 'C', 'D') + prop('hp', 'CELL_PUBLIC'))
      },
      'entity_defs/Child.def'
    );
    const hit = firstInherited(findings);
    expect(hit.message).toContain('interfaces/A.def、interfaces/B.def、interfaces/C.def');
    expect(hit.message).not.toContain('D.def');
  });

  it('单文件 method-property-collision 与继承链检查独立报', () => {
    const findings = analyzeEntry(
      {
        'entities.xml': '<root></root>',
        'entity_defs/Monster.def': entityDef(prop('hp', 'CELL_PUBLIC')),
        'entity_defs/Child.def': entityDef(
          parentTag('Monster') + prop('hp', 'CELL_PUBLIC') + method('BaseMethods', 'hp')
        )
      },
      'entity_defs/Child.def'
    );
    expect(findings.some(item => item.check === 'method-property-collision')).toBe(true);
    expect(findings.some(item => item.check === 'inherited-name-collision')).toBe(true);
  });

  it('单参调用(无闭包)保持既有行为不变', () => {
    const findings = analyzeDefDocument(entityDef(prop('hp', 'CELL_PUBLIC')));
    expect(findings).toEqual([]);
  });
});

describe('collectInheritedNames 闭包面', () => {
  it('闭包不含自身,含 Parent 与 Interfaces 传递闭包', () => {
    const root = tree({
      'entities.xml': '<root></root>',
      'entity_defs/Grandparent.def': entityDef(prop('gp', 'BASE')),
      'entity_defs/Monster.def': entityDef(parentTag('Grandparent') + prop('p', 'BASE')),
      'entity_defs/interfaces/Iface.def': entityDef(prop('i', 'BASE')),
      'entity_defs/Child.def': entityDef(
        parentTag('Monster') + interfacesTag('Iface') + prop('hp', 'CELL_PUBLIC')
      )
    });
    const inherited = collectInheritedNames(path.join(root, 'entity_defs/Child.def'));
    expect(inherited.has('gp')).toBe(true);
    expect(inherited.has('p')).toBe(true);
    expect(inherited.has('i')).toBe(true);
    expect(inherited.has('hp')).toBe(false);
  });

  it('接口文件作入口:闭包为空面(自身声明不入面,Parent 不产生边)', () => {
    const root = tree({
      'entities.xml': '<root></root>',
      'entity_defs/Grandparent.def': entityDef(prop('gp', 'BASE')),
      'entity_defs/interfaces/Iface.def': entityDef(parentTag('Grandparent') + prop('i', 'BASE')),
      'entity_defs/interfaces/Iface2.def': entityDef(prop('j', 'BASE'))
    });
    const inherited = collectInheritedNames(path.join(root, 'entity_defs/interfaces/Iface.def'));
    expect(inherited.size).toBe(0);
  });

  it('接口文件的 Interfaces 递归产生边(iface2 的声明入面)', () => {
    const root = tree({
      'entities.xml': '<root></root>',
      'entity_defs/interfaces/Iface.def': entityDef(interfacesTag('Iface2') + prop('i', 'BASE')),
      'entity_defs/interfaces/Iface2.def': entityDef(prop('j', 'BASE'))
    });
    const inherited = collectInheritedNames(path.join(root, 'entity_defs/interfaces/Iface.def'));
    expect(inherited.has('j')).toBe(true);
    expect(inherited.has('i')).toBe(false);
  });
});
