import { describe, expect, it } from 'vitest';
import {
  buildDefaultHotfixRequest,
  resolveDefaultHotfixModule,
  sendDefaultHotfix
} from '../src/hotReloadDefaultHotfix';
import type { HttpTransport } from '../src/httpRequestService';

// 默认热更请求(用户令 2026-11-06):新工作区零配置时保存 .py 即 POST
// http://127.0.0.1:8090/hotfix?module_name=<模块名>,body 同带 module_name=
// <模块名>(query 与 body 双带,服务端读哪个都取得到);端点与参数名是
// 硬契约(全仓不得再出现旧错误拼写),模块名优先 resolveModuleDualName
// 口径,未配脚本根回落 ${module} 包边界扫描(与内置示例模板同源)。

const probeFor = (dirs: string[]): ((dirPath: string) => boolean) => {
  const set = new Set(dirs);
  return dirPath => set.has(dirPath);
};

const okTransport = (seen: Array<{ url: string; method: string; body: string }>): HttpTransport =>
  request => {
    seen.push({ url: request.url, method: request.method, body: request.body });
    return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
  };

describe('buildDefaultHotfixRequest(默认端点与参数名)', () => {
  it('零配置:URL 带 ?module_name= 且 body 带 module_name=(双带)', () => {
    const request = buildDefaultHotfixRequest('/ws/scripts/base/Account.py');
    expect(request.method).toBe('POST');
    expect(request.body).toBe('module_name=Account');
    // 双带断言:query 与 body 各一份,缺一即红(服务端读哪个都取得到)
    expect(request.url).toBe('http://127.0.0.1:8090/hotfix?module_name=Account');
    expect(request.url).toContain('?module_name=Account');
    expect(request.body).toContain('module_name=Account');
    expect(JSON.stringify(request)).not.toContain(['rel', 'aod'].join(''));
  });

  it('包边界模块名进 body(entities/fight 各带 __init__.py → entities.fight.FightAI)', () => {
    const request = buildDefaultHotfixRequest('/ws/entities/fight/FightAI.py', {
      isPackageDir: probeFor(['/ws/entities', '/ws/entities/fight'])
    });
    expect(request.body).toBe('module_name=entities.fight.FightAI');
    expect(request.url).toBe('http://127.0.0.1:8090/hotfix?module_name=entities.fight.FightAI');
  });

  it('配了脚本资源根:按 resolveModuleDualName 全名口径(书 §19.1)', () => {
    const request = buildDefaultHotfixRequest('/ws/scripts/entities/fight/FightAI.py', {
      scriptRoot: '/ws/scripts'
    });
    expect(request.body).toBe('module_name=entities.fight.FightAI');
    // 文件不在脚本根内时如实回落包边界扫描,不编造名字
    expect(resolveDefaultHotfixModule('/elsewhere/base/Avatar.py', { scriptRoot: '/ws/scripts' })).toBe(
      'Avatar'
    );
  });
});

describe('sendDefaultHotfix(传输事实,不假成功)', () => {
  it('2xx 才算发出面成功(ok=true)', async () => {
    const seen: Array<{ url: string; method: string; body: string }> = [];
    const result = await sendDefaultHotfix(['/ws/scripts/base/Account.py'], {
      transport: okTransport(seen)
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('');
    expect(seen).toEqual([
      {
        url: 'http://127.0.0.1:8090/hotfix?module_name=Account',
        method: 'POST',
        body: 'module_name=Account'
      }
    ]);
    // 出口面同样双带:query 与 body 各一份
    expect(seen[0].url).toContain('?module_name=Account');
    expect(seen[0].body).toContain('module_name=Account');
  });

  it('引擎未起(连接拒绝)如实 ok=false 且带错误原因', async () => {
    const result = await sendDefaultHotfix(['/ws/scripts/base/Account.py'], {
      transport: () =>
        Promise.resolve({
          ok: false,
          status: 0,
          durationMs: 2,
          body: '',
          error: 'connect ECONNREFUSED 127.0.0.1:8090'
        })
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('非 2xx 如实失败(HTTP 状态入 detail)', async () => {
    const result = await sendDefaultHotfix(['/ws/scripts/base/Account.py'], {
      transport: () => Promise.resolve({ ok: true, status: 503, durationMs: 1, body: 'nope' })
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('503');
  });

  it('多文件逐个发送,任一失败整体如实失败', async () => {
    let calls = 0;
    const result = await sendDefaultHotfix(['/a/One.py', '/a/Two.py'], {
      transport: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' })
          : Promise.resolve({ ok: false, status: 0, durationMs: 1, body: '', error: 'boom' });
      }
    });
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('boom');
  });
});
