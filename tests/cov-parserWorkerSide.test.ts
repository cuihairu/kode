// pythonParserWorker 的 worker 侧消息处理面:模块级 parentPort.on 回调用
// 真 EventEmitter 替身驱动 —— 正常解析回包覆盖成功臂(parsePythonFile 产
// 物透传)。其余测试经 Worker 替身从宿主侧进,此文件专打 worker 侧分支。
import type { EventEmitter as EventEmitterType } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const parentState = vi.hoisted(() => ({
  emitter: null as unknown as EventEmitterType,
  posted: [] as Array<Record<string, unknown>>
}));

vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  const emitter = new EventEmitter();
  (emitter as unknown as { postMessage: (message: Record<string, unknown>) => void }).postMessage =
    (message: Record<string, unknown>): void => {
      parentState.posted.push(message);
    };
  parentState.emitter = emitter as unknown as EventEmitterType;
  return { parentPort: emitter };
});

describe('pythonParserWorker worker 侧消息处理', () => {
  beforeEach(() => {
    parentState.posted.length = 0;
  });

  it('收到解析请求 → 按 revision 回包解析产物', async () => {
    await import('../src/pythonParserWorker');
    parentState.emitter.emit('message', {
      id: 7,
      filePath: '/ws/scripts/hero.py',
      content: 'class Avatar:\n    def respawn(self):\n        pass\n',
      revision: 3
    });
    expect(parentState.posted).toHaveLength(1);
    expect(parentState.posted[0].id).toBe(7);
    expect(parentState.posted[0].revision).toBe(3);
    expect(parentState.posted[0]).toHaveProperty('parsed');
  });
});
