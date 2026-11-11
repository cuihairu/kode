/**
 * 局部变量返回注解 Rust 接收者定型面契约(精确性主车道批 D):
 * `$/kode/python/localReturnType`(kode-python local_return.rs)接住 TS 级联
 * 兜底删除后的同文件可推导子集——同文件 def 调用注解/self 方法/类限定方法/
 * 链式接收者/别名链,matchingAssignments 同域口径;推不出一律 null(诚实,
 * 不借名不硬造)。跨类同名方法不得误绑(批 D 靶心);类实例化原子经流证据
 * (callee_atom)参与接收者定型,但实例化本身不是返回注解(face 不答)。
 * 断言只对 Rust 主路径(生产装配 inferLocalReturnTypeFromRust);二进制缺失
 * 整套 skip(纯 TS 门禁不破坏);首例直连断言防旧二进制静默假绿。
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { inferLocalReturnTypeFromRust } from '../src/backend/localReturnTypeRust';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);
const suite = binaryReady ? describe : describe.skip;

const COLLISION_SAMPLE = [
  'class Repo:',
  '    def load(self) -> REPO_DATA:',
  '        return None',
  '',
  'class Noise:',
  '    def load(self):',
  '        return None',
  '',
  'svc = Repo()',
  'x = svc.load()'
].join('\n');

const CHAINED_SAMPLE = [
  'class Service:',
  '    def fetch(self) -> PAYLOAD:',
  '        return None',
  '',
  'svc = Service()',
  'cache = svc.fetch()'
].join('\n');

async function withRustGate(run: () => Promise<void>): Promise<void> {
  const client = new KodeCoreClient({
    binaryPath,
    initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
    onStderr: () => undefined
  });
  await client.start();
  setKodeCoreShadowGate({
    runInRust: async (method: string, params: unknown) => {
      const result = await client.request('$/kode/rpc', { method, params });
      return { ok: true as const, result };
    }
  } as unknown as KodeCoreGate);
  try {
    await run();
  } finally {
    setKodeCoreShadowGate(null);
    await client.dispose().catch(() => undefined);
  }
}

suite('localReturnType Rust 接收者定型面契约(精确性主车道批 D)', () => {
  it('直连断言:同文件 def 调用注解命中(旧二进制无此面显式红)', async () => {
    await withRustGate(async () => {
      const lines = ['def build() -> DATA:', '    pass', '', 'data = build()'];
      const face = await inferLocalReturnTypeFromRust(lines, 3, 'data', 'localret:probe');
      expect(face, '同文件 def 注解应命中(级联删除后由 Rust 面接住)').not.toBeNull();
      expect(face).toEqual({ target: 'data', annotation: 'DATA', methodName: 'build' });
    });
  });

  it('跨类同名方法不误绑:接收者定型到 Repo,不借 Noise(批 D 靶心)', async () => {
    await withRustGate(async () => {
      const lines = COLLISION_SAMPLE.split('\n');
      const face = await inferLocalReturnTypeFromRust(lines, 9, 'x', 'localret:collision');
      expect(face?.annotation).toBe('REPO_DATA');
      expect(face?.methodName).toBe('load');
      expect(face?.target).toBe('x');
    });
  });

  it('链式接收者别名链:svc=Service() → svc.fetch() → PAYLOAD', async () => {
    await withRustGate(async () => {
      const lines = CHAINED_SAMPLE.split('\n');
      const face = await inferLocalReturnTypeFromRust(lines, 5, 'cache', 'localret:chained');
      expect(face?.annotation).toBe('PAYLOAD');
    });
  });

  it('诚实 null 群:未知接收者/未注解 def/自引用别名/全大写常量名', async () => {
    await withRustGate(async () => {
      // 未知接收者:ghost 无类无写点 → null
      expect(await inferLocalReturnTypeFromRust(
        ['x = ghost.load()'], 0, 'x', 'localret:unknown'
      )).toBeNull();
      // 同文件 def 在但无注解 → null
      expect(await inferLocalReturnTypeFromRust(
        ['def plain():', '    pass', '', 'x = plain()'], 3, 'x', 'localret:noann'
      )).toBeNull();
      // 自引用别名(x = x) → null(环/恒等不硬造)
      expect(await inferLocalReturnTypeFromRust(
        ['x = x'], 0, 'x', 'localret:identity'
      )).toBeNull();
      // 全大写常量名不查询(与 TS 链同判据)
      expect(await inferLocalReturnTypeFromRust(
        ['DATA = build()'], 0, 'DATA', 'localret:const'
      )).toBeNull();
    });
  });

  it('self 方法调用:绑定到自己的类,同名方法不跨类(A/B 同名不误绑)', async () => {
    await withRustGate(async () => {
      const lines = [
        'class A:',
        '    def get(self) -> FROM_A:',
        '        return None',
        '',
        'class B:',
        '    def get(self) -> FROM_B:',
        '        return None',
        '',
        'class Driver:',
        '    def get(self) -> FROM_DRIVER:',
        '        return None',
        '',
        '    def tick(self):',
        '        v = self.get()'
      ].join('\n');
      const face = await inferLocalReturnTypeFromRust(lines.split('\n'), 13, 'v', 'localret:selfmethod');
      expect(face?.annotation).toBe('FROM_DRIVER');
    });
  });

  it('同域口径:兄弟方法写点不借用;悬停行写入即时生效', async () => {
    await withRustGate(async () => {
      const lines = [
        'def build() -> DATA:',
        '    pass',
        '',
        'class Avatar:',
        '    def a(self):',
        '        v = build()',
        '',
        '    def b(self):',
        '        w = v'
      ].join('\n');
      const docLines = lines.split('\n');
      // b 内读 v:写点在兄弟方法 a 域内 → 不借用 → null
      expect(await inferLocalReturnTypeFromRust(docLines, 8, 'w', 'localret:scope')).toBeNull();
      // a 域内:v 即时命中
      expect((await inferLocalReturnTypeFromRust(docLines, 5, 'v', 'localret:scope'))?.annotation)
        .toBe('DATA');
    });
  });

  it('versionKey 缓存键:同键重复查询一致(解析缓存复用面)', async () => {
    await withRustGate(async () => {
      const lines = CHAINED_SAMPLE.split('\n');
      const first = await inferLocalReturnTypeFromRust(lines, 5, 'cache', 'localret:lru');
      const second = await inferLocalReturnTypeFromRust(lines, 5, 'cache', 'localret:lru');
      expect(second).toEqual(first);
    });
  });
});
