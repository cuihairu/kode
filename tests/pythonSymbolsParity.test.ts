import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import type { PythonSymbolCall, PythonSymbolMethod, PythonSymbolsRustResult } from '../src/pythonCallGraphRust';
import { parsePythonMethodBlocks, rustSymbolsToIndexedMethodLocations } from '../src/entityMapping';

// C-20 交付⑤:Rust 符号表 → C-19 方法定位的列号口径漂移回归。
//
// 事实:rustSymbolsToIndexedMethodLocations 从 Rust AST 方法枚举 + 自身调用
// 点(0-based)派生 C-19 消费的 line/character/endLine。Rust 的 line/character
// 是 def 语句起点(装饰器行/def 关键字列),与 TS parsePythonMethodBlocks 的
// 「def 行 1-based + 方法名列」不同口径——若不做对齐,C-19 诊断/跳转会漂移。
// 本测试用与 probe 一致的 canned Rust 符号(0-based 真实值)喂映射,断言与
// TS 正则自建逐字段一致(含装饰器形态与调用点 self. 前缀列偏移)。

const readFixture = (name: string): string =>
  readFileSync(`tests/fixtures/kbengine-demo-assets/scripts/cell/${name}`, 'utf8');

const sym = (
  name: string,
  line: number,
  character: number,
  endLine: number,
  calls: Array<[string, number, number]> = []
): PythonSymbolMethod => ({
  name,
  line,
  character,
  isAsync: false,
  decorators: [],
  params: [],
  endLine,
  calls: calls.map(([methodName, callLine, callCharacter]): PythonSymbolCall => ({
    methodName,
    line: callLine,
    character: callCharacter
  }))
});

const fileSymbols = (filePath: string, methods: PythonSymbolMethod[]): PythonSymbolsRustResult => [
  {
    filePath,
    lineCount: 1,
    classes: [
      {
        name: 'Demo',
        qualifiedName: 'Demo',
        bases: [],
        startLine: 0,
        endLine: methods.length ? methods[methods.length - 1].endLine : 0,
        decorators: [],
        methods,
        attributes: []
      }
    ],
    functions: [],
    imports: [],
    errors: []
  }
];

const normalized = (methods: ReturnType<typeof parsePythonMethodBlocks>) =>
  methods
    .map(method => ({
      methodName: method.methodName,
      line: method.line,
      character: method.character,
      endLine: method.endLine,
      calls: [...method.calls]
        .map(call => ({ methodName: call.methodName, line: call.line, character: call.character }))
        .sort((a, b) => a.line - b.line || a.character - b.character || a.methodName.localeCompare(b.methodName))
    }))
    .sort((a, b) => a.line - b.line || a.methodName.localeCompare(b.methodName));

describe('rustSymbolsToIndexedMethodLocations', () => {
  it('Monster.py:Rust 0-based 符号与 TS 正则自建逐字段一致(含调用点 self. 列偏移)', () => {
    const path = 'tests/fixtures/kbengine-demo-assets/scripts/cell/Monster.py';
    const text = readFixture('Monster.py');
    const symbols = fileSymbols(path, [
      // 2026-11-07:DEMO-GAME-002 AI 状态机落地(决策/执行分离),方法面全量锁定
      sym('__init__', 16, 1, 26, [['addTimer', 25, 2]]),
      sym('onAggro', 27, 1, 33),
      sym('onDamaged', 34, 1, 43),
      sym('onMove', 44, 1, 53),
      sym('onMoveOver', 54, 1, 59),
      sym('onMoveFailure', 60, 1, 66),
      sym('think', 67, 1, 70, [['respawn', 69, 2]]),
      sym('_pickTarget', 71, 1, 94, [['entitiesInRange', 84, 11]]),
      sym('_setState', 95, 1, 107),
      sym('_moveToPoint', 108, 1, 111, [['moveToPoint', 110, 2]]),
      sym('onTimer', 112, 1, 162, [
        ['_pickTarget', 120, 11],
        ['_setState', 135, 2],
        ['_moveToPoint', 139, 4],
        ['moveToEntity', 146, 4],
        ['_moveToPoint', 160, 4]
      ])
    ]);
    const rust = rustSymbolsToIndexedMethodLocations([{ path, text }], symbols);
    expect(normalized(rust)).toEqual(normalized(parsePythonMethodBlocks(text, path)));
  });

  it('Avatar.py:同一口径(notifyMove 的 onMove 调用 0-based 62 col 2 → 1-based 63 col 7)', () => {
    const path = 'tests/fixtures/kbengine-demo-assets/scripts/cell/Avatar.py';
    const text = readFixture('Avatar.py');
    const symbols = fileSymbols(path, [
      // 2026-11-07:DEMO-GAME-002 receiveDamage 插入(cell/Avatar.py onEnterSpace 后),
      // onLeaveSpace 之后锚点 +18(锚点证据块见 docs/acceptance-evidence/DEMO-GAME-002.md)
      sym('__init__', 6, 1, 8),
      sym('respawn', 9, 1, 15),
      sym('onEnterSpace', 16, 1, 25),
      sym('receiveDamage', 26, 1, 43),
      sym('onLeaveSpace', 44, 1, 50),
      sym('onMove', 51, 1, 60),
      sym('notifyMove', 61, 1, 64, [['onMove', 63, 2]])
    ]);
    const rust = rustSymbolsToIndexedMethodLocations([{ path, text }], symbols);
    expect(normalized(rust)).toEqual(normalized(parsePythonMethodBlocks(text, path)));
  });

  it('装饰器方法:Rust 行是装饰器行,映射回扫到 def 行(行/列/endLine 对齐)', () => {
    const text = [
      'class Demo:',
      '\t@staticmethod',
      '\tdef helper(a):',
      '\t\treturn a',
      '',
      '\t@classmethod',
      '\tdef build(cls):',
      '\t\treturn cls()'
    ].join('\n');
    const path = '/scripts/cell/Demo.py';
    // Rust 报装饰器行(0-based 1 / 5);TS 口径是 def 行(1-based 3 / 7)。
    const symbols = fileSymbols(path, [sym('helper', 1, 1, 3), sym('build', 5, 1, 7)]);
    const rust = rustSymbolsToIndexedMethodLocations([{ path, text }], symbols);
    expect(normalized(rust)).toEqual(normalized(parsePythonMethodBlocks(text, path)));
  });

  it('self(...) 无方法名链不产出调用(TS 正则本就不记,过滤对齐)', () => {
    const path = '/scripts/cell/Weird.py';
    const text = ['class Weird:', '\tdef go(self):', '\t\tself()'].join('\n');
    const symbols = fileSymbols(path, [sym('go', 1, 1, 2, [['self', 2, 2]])]);
    const rust = rustSymbolsToIndexedMethodLocations([{ path, text }], symbols);
    expect(normalized(rust)).toEqual(normalized(parsePythonMethodBlocks(text, path)));
  });

  it('无对应符号文件的输入不产出(防御:files 与 symbols 不同步)', () => {
    const rust = rustSymbolsToIndexedMethodLocations(
      [{ path: '/a.py', text: 'class A:\n\tdef x(self):\n\t\tpass' }],
      []
    );
    expect(rust).toEqual([]);
  });
});
