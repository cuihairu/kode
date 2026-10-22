import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefCallChain, renderDefCallChainMermaid } from '../src/defCallChain';
import type { EntityMappingIndex } from '../src/entityMapping';

const rootDef = join('/tmp/project', 'scripts', 'entity_defs', 'Hero.def');
const baseFile = join('/tmp/project', 'scripts', 'base', 'Hero.py');
const cellFile = join('/tmp/project', 'scripts', 'cell', 'Hero.py');

const definition = (name: string, section: string, line: number) => ({
  defFile: rootDef,
  line,
  section,
  exposed: false,
  owner: { kind: 'entity', name: 'Hero', filePath: rootDef, line: 1 },
  declaredArgs: ['UINT32'],
  identity: {
    ownerKind: 'entity',
    ownerName: 'Hero',
    sourceKind: 'local',
    sourceChain: ['Hero'],
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
  bindingName: string,
  calls: Array<{ methodName: string; line: number; character: number; filePath: string }> = []
) => ({
  filePath,
  methodName,
  line,
  character: 4,
  endLine,
  calls,
  binding: {
    pythonFile: filePath,
    identity: {
      ownerKind: 'entity',
      ownerName: 'Hero',
      sourceKind: 'local',
      sourceChain: ['Hero'],
      section: bindingSection,
      symbolName: bindingName
    }
  }
});

const fileContents: Record<string, string> = {
  [baseFile]: [
    'class Hero:',
    '    def start(self, amount):',
    '        self.cell.move(1)',
    '        self.cell.missing()',
    '    def finish(self, amount):',
    '        self.cell.move(3)'
  ].join('\n'),
  [cellFile]: [
    'class Hero:',
    '    def move(self, amount):',
    '        self.base.finish(2)'
  ].join('\n')
};

const index: EntityMappingIndex = {
  rootName: 'Hero',
  rootCategory: 'entity',
  rootDefFile: rootDef,
  semantics: {} as EntityMappingIndex['semantics'],
  propertyDefinitions: [],
  methodDefinitions: [
    definition('start', 'BaseMethods', 2),
    definition('move', 'CellMethods', 2),
    definition('finish', 'BaseMethods', 4)
  ],
  pythonOwnerFiles: [],
  pythonMethods: [
    pythonMethod(baseFile, 'start', 1, 3, 'BaseMethods', 'start', [
      { methodName: 'move', line: 2, character: 19, filePath: baseFile },
      { methodName: 'missing', line: 3, character: 21, filePath: baseFile }
    ]),
    pythonMethod(cellFile, 'move', 1, 3, 'CellMethods', 'move', [
      { methodName: 'finish', line: 2, character: 20, filePath: cellFile }
    ]),
    pythonMethod(baseFile, 'finish', 4, 5, 'BaseMethods', 'finish', [
      { methodName: 'move', line: 5, character: 20, filePath: baseFile }
    ])
  ]
};

const buildChain = (
  start: { line: number; methodName: string },
  options: { depth?: number } = {}
) => buildDefCallChain(index, { filePath: rootDef, methodName: start.methodName, line: start.line }, {
  ...options,
  readPythonFile: filePath => fileContents[filePath] ?? null
});

describe('def call chain', () => {
  let temporaryRoot = '';

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'def-chain-'));
    mkdirSync(join(temporaryRoot, 'base'), { recursive: true });
    mkdirSync(join(temporaryRoot, 'cell'), { recursive: true });
    writeFileSync(join(temporaryRoot, 'base', 'Hero.py'), fileContents[baseFile]);
    writeFileSync(join(temporaryRoot, 'cell', 'Hero.py'), fileContents[cellFile]);
  });

  it('builds base to cell to base with unresolved target', () => {
    const chain = buildChain({ line: 2, methodName: 'start' });
    expect(chain).not.toBeNull();
    expect(chain?.nodes.map(node => `${node.section}:${node.methodName}`)).toEqual([
      'BaseMethods:start',
      'CellMethods:move',
      'CellMethods:missing',
      'BaseMethods:finish'
    ]);
    expect(chain?.edges.map(edge => `${edge.from}>${edge.to}:${edge.receiver}`)).toEqual([
      'Hero:BaseMethods:start>Hero:CellMethods:move:cell',
      'Hero:BaseMethods:start>Hero:CellMethods:missing:unresolved:cell',
      'Hero:CellMethods:move>Hero:BaseMethods:finish:base',
      'Hero:BaseMethods:finish>Hero:CellMethods:move:cell'
    ]);
  });

  it('cuts cycles while retaining the return edge', () => {
    const chain = buildChain({ line: 2, methodName: 'start' }, { depth: 5 });
    expect(chain?.nodes).toHaveLength(4);
    expect(chain?.edges).toHaveLength(4);
  });

  it('scans only the root at depth zero and direct calls at depth one', () => {
    expect(buildChain({ line: 2, methodName: 'start' }, { depth: 0 })?.nodes).toHaveLength(1);
    const directChain = buildChain({ line: 2, methodName: 'start' }, { depth: 1 });
    expect(directChain?.nodes).toHaveLength(3);
    expect(directChain?.edges).toHaveLength(2);
  });

  it('returns null when the declaration cannot be found', () => {
    expect(buildDefCallChain(index, { filePath: rootDef, methodName: 'missing' })).toBeNull();
  });

  it('renders a stable mermaid flowchart', () => {
    const chain = buildChain({ line: 2, methodName: 'start' })!;
    expect(renderDefCallChainMermaid(chain)).toBe([
      'flowchart TD',
      '    Hero:BaseMethods:start["BaseMethods.start(UINT32)"]',
      '    Hero:CellMethods:move["CellMethods.move(UINT32)"]',
      '    Hero:CellMethods:missing:unresolved(["CellMethods.missing(?)"])',
      '    Hero:BaseMethods:finish["BaseMethods.finish(UINT32)"]',
      `    Hero:BaseMethods:start -->|cell| Hero:CellMethods:move`,
      `    Hero:BaseMethods:start -->|cell| Hero:CellMethods:missing:unresolved`,
      `    Hero:CellMethods:move -->|base| Hero:BaseMethods:finish`,
      `    Hero:BaseMethods:finish -->|cell| Hero:CellMethods:move`
    ].join('\n'));
  });

  afterEach(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });
});
