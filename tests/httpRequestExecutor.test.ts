import { describe, expect, it } from 'vitest';
import {
  classifyExecution,
  createHttpExchangeMachine,
  executeHttpRequest,
  newCorrelationId,
  type HttpRequestOutcome
} from '../src/backend/httpRequestExecutor';
import type { HttpTransport, OutgoingHttpRequest } from '../src/backend/httpRequestService';

// 通用 HTTP 请求执行器(HR-PR-03):HR-HTTP-010 结果六分类+错误细类、
// 交换状态机非法迁移拒绝、HR-HTTP-014 关联 id 生成/贯穿、HR-HTTP-009
// 默认不自动重试(传输一次一发)。mock server 真网 e2e 见同目录
// httpRequestExecutorMockServer.test.ts。

describe('classifyExecution(HR-HTTP-010 结果分类,传输事实决定不猜)', () => {
  it('2xx=ok;非 2xx=non-2xx+http-status;transportOk 恒等于传输面原始 ok', () => {
    const ok = classifyExecution({ ok: true, status: 200, durationMs: 3, body: 'hi' }, 'id-1');
    expect(ok).toEqual({
      correlationId: 'id-1',
      kind: 'ok',
      transportOk: true,
      status: 200,
      durationMs: 3,
      body: 'hi'
    });
    const redirect = classifyExecution({ ok: true, status: 302, durationMs: 1, body: '' }, 'id-2');
    expect(redirect.kind).toBe('non-2xx');
    expect(redirect.errorCategory).toBe('http-status');
    expect(redirect.transportOk).toBe(true);
    const serverError = classifyExecution({ ok: true, status: 503, durationMs: 1, body: 'nope' }, 'id-3');
    expect(serverError.kind).toBe('non-2xx');
    expect(serverError.errorCategory).toBe('http-status');
  });

  it('错误信息映射:自有 transport 确定性标记+node 网络错误码;其余如实 unknown', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['请求超时(10000ms)', 'timeout', 'timeout'],
      ['URL 无法解析: not-a-url', 'invalid-url', 'invalid-url'],
      ['不支持的协议: ftp:', 'unsupported-protocol', 'unsupported-protocol'],
      ['connect ECONNREFUSED 127.0.0.1:8090', 'network-error', 'connection-refused'],
      ['getaddrinfo ENOTFOUND hotfix.local', 'network-error', 'dns'],
      ['connect EAI_AGAIN', 'network-error', 'dns'],
      ['socket hang up', 'network-error', 'connection-reset'],
      ['read ECONNRESET', 'network-error', 'connection-reset'],
      ['某种未知传输错误', 'network-error', 'unknown']
    ];
    for (const [error, kind, category] of cases) {
      const outcome = classifyExecution(
        { ok: false, status: 0, durationMs: 1, body: '', error },
        'id'
      );
      expect(outcome.kind).toBe(kind);
      expect(outcome.errorCategory).toBe(category);
      expect(outcome.transportOk).toBe(false);
      expect(outcome.errorMessage).toBe(error);
    }
  });

  it('失败缺 error 字段:network-error/unknown,无 errorMessage 字段(不硬造)', () => {
    const outcome = classifyExecution({ ok: false, status: 0, durationMs: 1, body: '' }, 'id');
    expect(outcome.kind).toBe('network-error');
    expect(outcome.errorCategory).toBe('unknown');
    expect('errorMessage' in outcome).toBe(false);
  });

  it('畸形 fake(ok=true,status=0):transportOk 仍 true,服务层分支语义不变', () => {
    const weird = classifyExecution({ ok: true, status: 0, durationMs: 0, body: '' }, 'id');
    expect(weird.transportOk).toBe(true);
    expect(weird.kind).toBe('non-2xx');
  });
});

describe('交换状态机(HR-PR-03 状态机面:idle→in-flight→settled 单向)', () => {
  it('合法路径 idle→send→in-flight→settle→settled', () => {
    const machine = createHttpExchangeMachine();
    expect(machine.state).toBe('idle');
    expect(machine.advance('settle')).toMatchObject({ ok: false, from: 'idle', event: 'settle' });
    expect(machine.advance('send')).toEqual({ ok: true, from: 'idle', next: 'in-flight' });
    expect(machine.state).toBe('in-flight');
    expect(machine.canAdvance('send')).toBe(false);
    expect(machine.canAdvance('settle')).toBe(true);
    expect(machine.advance('settle')).toEqual({ ok: true, from: 'in-flight', next: 'settled' });
    expect(machine.state).toBe('settled');
  });

  it('终态 settled 拒绝一切事件;拒绝带原因,绝不静默跳态', () => {
    const machine = createHttpExchangeMachine();
    machine.advance('send');
    machine.advance('settle');
    for (const event of ['send', 'settle'] as const) {
      const refused = machine.advance(event);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.from).toBe('settled');
        expect(refused.reason).toContain('沉降');
      }
      expect(machine.state).toBe('settled');
    }
  });

  it('双发送拒绝(in-flight 不接受 send)', () => {
    const machine = createHttpExchangeMachine();
    machine.advance('send');
    const refused = machine.advance('send');
    expect(refused).toMatchObject({ ok: false, from: 'in-flight', event: 'send' });
  });
});

describe('newCorrelationId(HR-HTTP-014)', () => {
  it('每次执行唯一;外部给定 id 原样贯穿', async () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
    const seen: string[] = [];
    const transport: HttpTransport = async request => {
      seen.push(request.url);
      return { ok: true, status: 200, durationMs: 1, body: '' };
    };
    const a = await executeHttpRequest(req('http://127.0.0.1/a'), { transport });
    const b = await executeHttpRequest(req('http://127.0.0.1/b'), { transport });
    expect(a.correlationId).not.toBe(b.correlationId);
    const fixed = await executeHttpRequest(req('http://127.0.0.1/c'), {
      transport,
      correlationId: 'caller-fixed-id'
    });
    expect(fixed.correlationId).toBe('caller-fixed-id');
    expect(seen).toHaveLength(3);
  });
});

describe('executeHttpRequest(单次执行,不重试)', () => {
  it('请求逐字透传传输面;传输失败恰调一次(HR-HTTP-009 默认不自动重试)', async () => {
    const calls: OutgoingHttpRequest[] = [];
    const transport: HttpTransport = async request => {
      calls.push(request);
      return { ok: false, status: 0, durationMs: 2, body: '', error: 'connect ECONNREFUSED 127.0.0.1:1' };
    };
    const outcome = await executeHttpRequest(
      {
        url: 'http://127.0.0.1:8090/hotfix?module_name=Account',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'module_name=Account',
        timeoutMs: 4000
      },
      { transport }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:8090/hotfix?module_name=Account',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'module_name=Account',
      timeoutMs: 4000
    });
    expect(outcome.kind).toBe('network-error');
    expect(outcome.errorCategory).toBe('connection-refused');
  });

  it('outcome 形状:成功全字段齐,失败按有无 error 收放(分类附加不改服务层行为)', async () => {
    const transport: HttpTransport = async () => ({ ok: true, status: 204, durationMs: 5, body: '' });
    const outcome: HttpRequestOutcome = await executeHttpRequest(req('http://127.0.0.1/ok'), { transport });
    expect(outcome.kind).toBe('ok');
    expect(outcome.status).toBe(204);
    expect(outcome.durationMs).toBe(5);
    expect('errorCategory' in outcome).toBe(false);
    expect('errorMessage' in outcome).toBe(false);
  });
});

const req = (url: string): OutgoingHttpRequest => ({
  url,
  method: 'GET',
  headers: {},
  body: '',
  timeoutMs: 1000
});
