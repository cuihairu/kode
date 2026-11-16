// python 方法调用层次纯核单测钉(RUST-145 批 1)。语义面整体由 golden
// 对拍 tests/kodePythonMethodCallsParity.test.ts 把守(Rust↔TS 同语料
// 复算);此处只钉 golden 语料未覆盖的 TS 侧面:迁移兼容链(entityMapping
// Helpers re-export 与 backend 纯核同一函数)、async 可选组回溯语义、
// 路径身份归一(../ 词法折叠)下的 outgoing 目标定位。
import { describe, expect, it } from 'vitest';
import {
  inferMethodSectionFromPythonFile,
  parsePythonMethodBlocks,
  resolveOutgoingPythonMethodCalls
} from '../src/backend/pythonMethodCallQueries';
import {
  inferMethodSectionFromPythonFile as inferViaHelpers,
  parsePythonMethodBlocks as parseViaHelpers
} from '../src/entityMappingHelpers';

describe('python method call queries 纯核(RUST-145 批 1)', () => {
  it('迁移兼容:entityMappingHelpers re-export 与 backend 纯核同一函数', () => {
    expect(parseViaHelpers).toBe(parsePythonMethodBlocks);
    expect(inferViaHelpers).toBe(inferMethodSectionFromPythonFile);
  });

  it('async 可选组回溯:async 后非 def 不匹配,裸 def 路正常(JS 回溯同构)', () => {
    const blocks = parsePythonMethodBlocks(
      ['class A:', '    async def go(self):', '        pass', '    asynchelper(self)', '    def plain(self):', '        pass', ''].join('\n'),
      '/proj/scripts/base/a.py'
    );
    const names = blocks.map(block => block.methodName);
    // asynchelper 行:async 路失败(无 def)→ 裸 def 路也失败(行首 async
    // 不是 def)→ 不出方法块
    expect(names).toEqual(['go', 'plain']);
    expect(blocks[0].calls).toEqual([]);
  });

  it('outgoing 目标定位走路径身份归一:../ 词法折叠同键', () => {
    const methods = parsePythonMethodBlocks(
      ['class A:', '    def caller(self):', '        self.work()', '    def work(self):', '        pass', ''].join('\n'),
      '/proj/scripts/base/../base/a.py'
    );
    const references = resolveOutgoingPythonMethodCalls(methods, '/proj/scripts/base/a.py', 'caller');
    expect(references).toHaveLength(1);
    expect(references[0]).toEqual({
      filePath: '/proj/scripts/base/../base/a.py',
      methodName: 'work',
      line: 4,
      character: 8
    });
  });
});
