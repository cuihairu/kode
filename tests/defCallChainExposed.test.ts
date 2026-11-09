import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDefCallChain, renderDefCallChainMermaid } from '../src/backend/defCallChain';
import type { EntityMappingIndex } from '../src/entityMapping';

// 回归面:Exposed 方法的 client 入边(Part A)+ 普通 self.X() 调用按本段跟随
// (Part B)。用户案:reqGoto 是 Exposed → 期望 client -> CellMethods.reqGoto
// -> self.moveToPoint。
const rootDef = join('/tmp/project', 'scripts', 'entity_defs', 'Avatar.def');
const baseFile = join('/tmp/project', 'scripts', 'base', 'Avatar.py');
const cellFile = join('/tmp/project', 'scripts', 'cell', 'Avatar.py');

const definition = (name: string, section: string, line: number, exposed = false) => ({
  defFile: rootDef,
  line,
  section,
  exposed,
  owner: { kind: 'entity', name: 'Avatar', filePath: rootDef, line: 1 },
  declaredArgs: ['UINT32'],
  identity: {
    ownerKind: 'entity',
    ownerName: 'Avatar',
    sourceKind: 'local',
    sourceChain: ['Avatar'],
    section,
    symbolName: name
  }
});

const pythonMethod = (
  filePath: string,
  methodName: string,
  line: number,
  endLine: number,
  bindingSection: string,
  bindingName: string
) => ({
  filePath,
  methodName,
  line,
  character: 4,
  endLine,
  calls: [],
  binding: {
    pythonFile: filePath,
    identity: {
      ownerKind: 'entity',
      ownerName: 'Avatar',
      sourceKind: 'local',
      sourceChain: ['Avatar'],
      section: bindingSection,
      symbolName: bindingName
    }
  }
});

const fileContents: Record<string, string> = {
  [cellFile]: [
    'class Avatar:',
    '    def plainExposed(self):',
    '        pass',
    '    def reqGoto(self):',
    '        self.moveToPoint(',
    '            (1, 2, 3),',
    '            1.0, 0.0, None, False, False,',
    '        )',
    '    def moveToPoint(self):',
    '        self.base.finish(2)'
  ].join('\n'),
  [baseFile]: [
    'class Avatar:',
    '    def start(self, amount):',
    '        self.cell.move(1)',
    '        self.cell.missing()',
    '    def finish(self, amount):',
    '        self.cell.move(3)'
  ].join('\n')
};

interface DefSpec {
  name: string;
  section: string;
  line: number;
  exposed?: boolean;
}

interface PySpec {
  filePath: string;
  methodName: string;
  line: number;
  endLine: number;
  bindingSection: string;
  bindingName: string;
}

const makeIndex = (defs: DefSpec[], pys: PySpec[]): EntityMappingIndex => ({
  rootName: 'Avatar',
  rootCategory: 'entity',
  rootDefFile: rootDef,
  semantics: {} as EntityMappingIndex['semantics'],
  propertyDefinitions: [],
  methodDefinitions: defs.map(def => definition(def.name, def.section, def.line, def.exposed ?? false)),
  pythonOwnerFiles: [],
  pythonMethods: pys.map(py => pythonMethod(
    py.filePath,
    py.methodName,
    py.line,
    py.endLine,
    py.bindingSection,
    py.bindingName
  ))
});

const makeChain = (index: EntityMappingIndex, line: number, methodName: string) =>
  buildDefCallChain(index, { filePath: rootDef, methodName, line }, {
    depth: 4,
    readPythonFile: filePath => fileContents[filePath] ?? null
  });

const reqGotoPy: PySpec = {
  filePath: cellFile,
  methodName: 'reqGoto',
  line: 4,
  endLine: 8,
  bindingSection: 'CellMethods',
  bindingName: 'reqGoto'
};

describe('def call chain exposed + plain self calls', () => {
  it('exposed root gains a synthetic client source node and incoming client edge', () => {
    const index = makeIndex(
      [{ name: 'plainExposed', section: 'CellMethods', line: 2, exposed: true }],
      [{
        filePath: cellFile,
        methodName: 'plainExposed',
        line: 2,
        endLine: 3,
        bindingSection: 'CellMethods',
        bindingName: 'plainExposed'
      }]
    );
    const chain = makeChain(index, 2, 'plainExposed');
    expect(chain).not.toBeNull();
    expect(chain?.nodes.map(node => node.id)).toContain('client');
    expect(chain?.nodes.find(node => node.id === 'client')).toMatchObject({
      entity: 'client',
      methodName: '',
      section: 'ClientMethods',
      signature: 'client',
      resolved: true
    });
    expect(chain?.edges).toContainEqual({
      from: 'client',
      to: 'Avatar:CellMethods:plainExposed',
      receiver: 'client'
    });
    const mermaid = renderDefCallChainMermaid(chain!);
    expect(mermaid).toContain('client(["client"])');
    expect(mermaid).toContain('client -->|client| Avatar:CellMethods:plainExposed');
  });

  it('plain self.X() call resolves to own-section def method when present', () => {
    const index = makeIndex(
      [
        { name: 'reqGoto', section: 'CellMethods', line: 4 },
        { name: 'moveToPoint', section: 'CellMethods', line: 9 }
      ],
      [
        reqGotoPy,
        {
          filePath: cellFile,
          methodName: 'moveToPoint',
          line: 9,
          endLine: 10,
          bindingSection: 'CellMethods',
          bindingName: 'moveToPoint'
        }
      ]
    );
    const chain = makeChain(index, 4, 'reqGoto');
    expect(chain?.edges).toContainEqual({
      from: 'Avatar:CellMethods:reqGoto',
      to: 'Avatar:CellMethods:moveToPoint',
      receiver: 'cell'
    });
    expect(chain?.nodes.find(node => node.id === 'Avatar:CellMethods:moveToPoint')?.resolved).toBe(true);
    // 未 Exposed 根:不产生 client 节点
    expect(chain?.nodes.some(node => node.id === 'client')).toBe(false);
  });

  it('plain self.X() call to missing def method becomes unresolved own-section node', () => {
    const index = makeIndex(
      [{ name: 'reqGoto', section: 'CellMethods', line: 4 }],
      [reqGotoPy]
    );
    const chain = makeChain(index, 4, 'reqGoto');
    expect(chain?.edges).toContainEqual({
      from: 'Avatar:CellMethods:reqGoto',
      to: 'Avatar:CellMethods:moveToPoint:unresolved',
      receiver: 'cell'
    });
    expect(chain?.nodes.find(node => node.id === 'Avatar:CellMethods:moveToPoint:unresolved')).toMatchObject({
      section: 'CellMethods',
      methodName: 'moveToPoint',
      resolved: false,
      signature: 'CellMethods.moveToPoint(?)'
    });
  });

  it('user case: exposed reqGoto with plain moveToPoint gives client -> reqGoto -> moveToPoint', () => {
    const index = makeIndex(
      [{ name: 'reqGoto', section: 'CellMethods', line: 4, exposed: true }],
      [reqGotoPy]
    );
    const chain = makeChain(index, 4, 'reqGoto');
    expect(chain).not.toBeNull();
    expect(chain?.nodes.map(node => node.id)).toContain('client');
    // client 源纯来源,不进 BFS/解析链:除 client 与 reqGoto/moveToPoint 外无多余节点
    expect(chain?.edges).toContainEqual({
      from: 'client',
      to: 'Avatar:CellMethods:reqGoto',
      receiver: 'client'
    });
    expect(chain?.edges).toContainEqual({
      from: 'Avatar:CellMethods:reqGoto',
      to: 'Avatar:CellMethods:moveToPoint:unresolved',
      receiver: 'cell'
    });
    // chainText 组成面:client 边显示 client --client--> CellMethods.reqGoto(...)
    expect(chain?.nodes.find(node => node.id === 'Avatar:CellMethods:reqGoto')?.signature).toBe('CellMethods.reqGoto(UINT32)');
  });

  it('plain extractor does not double-count self.cell.X / self.base.X receiver calls', () => {
    const index = makeIndex(
      [{ name: 'start', section: 'BaseMethods', line: 2 }],
      [{
        filePath: baseFile,
        methodName: 'start',
        line: 2,
        endLine: 4,
        bindingSection: 'BaseMethods',
        bindingName: 'start'
      }]
    );
    const chain = makeChain(index, 2, 'start');
    // start 体只有 self.cell.move / self.cell.missing 两条接收者调用,无普通 self.X
    expect(chain?.edges.filter(edge => edge.from === 'Avatar:BaseMethods:start')).toHaveLength(2);
    expect(chain?.nodes.some(node => node.id === 'client')).toBe(false);
    expect(chain?.edges.some(edge => edge.from === 'client')).toBe(false);
  });

  it('exposed: false (default) produces no client source node', () => {
    const index = makeIndex(
      [{ name: 'start', section: 'BaseMethods', line: 2 }],
      [{
        filePath: baseFile,
        methodName: 'start',
        line: 2,
        endLine: 4,
        bindingSection: 'BaseMethods',
        bindingName: 'start'
      }]
    );
    const chain = makeChain(index, 2, 'start');
    expect(chain?.nodes.some(node => node.id === 'client')).toBe(false);
    expect(chain?.edges.some(edge => edge.from === 'client')).toBe(false);
  });
});
