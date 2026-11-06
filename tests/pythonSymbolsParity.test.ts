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
      sym('__init__', 17, 1, 27, [['addTimer', 26, 2]]),
      sym('onAggro', 28, 1, 34),
      sym('onDamaged', 35, 1, 44),
      sym('onMove', 45, 1, 54),
      sym('onMoveOver', 55, 1, 60),
      sym('onMoveFailure', 61, 1, 67),
      sym('receiveDamage', 68, 1, 87, [['onDamaged', 74, 2], ['destroy', 86, 3]]),
      sym('think', 88, 1, 91, [['respawn', 90, 2]]),
      sym('_pickTarget', 92, 1, 115, [['entitiesInRange', 105, 11]]),
      sym('_setState', 116, 1, 128),
      sym('_moveToPoint', 129, 1, 132, [['moveToPoint', 131, 2]]),
      sym('onTimer', 133, 1, 183, [
        ['_pickTarget', 141, 11],
        ['_setState', 156, 2],
        ['_moveToPoint', 160, 4],
        ['moveToEntity', 167, 4],
        ['_moveToPoint', 181, 4]
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
      sym('__init__', 10, 1, 16, [['addTimer', 15, 2]]),
      sym('onTimer', 17, 1, 34, [['entitiesInRange', 24, 11], ['_attack', 33, 3]]),
      sym('_attack', 35, 1, 47),
      sym('reqAttack', 48, 1, 63, [['_attack', 62, 2]]),
      sym('respawn', 64, 1, 70),
      sym('onEnterSpace', 71, 1, 80),
      sym('receiveDamage', 81, 1, 108),
      sym('onLeaveSpace', 109, 1, 115),
      sym('onMove', 116, 1, 125),
      sym('notifyMove', 126, 1, 129, [['onMove', 128, 2]])
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
