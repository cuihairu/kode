import { describe, expect, it } from 'vitest';
import {
  buildDefaultHotfixRequest,
  resolveDefaultHotfixModule,
  sendDefaultHotfix
} from '../src/backend/hotReloadDefaultHotfix';
import type { HttpTransport } from '../src/backend/httpRequestService';

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

  it('配了脚本资源根:线路送 requestModule 短名(fight.FightAI),UI 展示 fullModule 全名(HR-DOD-001)', () => {
    const request = buildDefaultHotfixRequest('/ws/scripts/entities/fight/FightAI.py', {
      scriptRoot: '/ws/scripts'
    });
    // HR-DOD-001:scripts/entities 不在引擎 sys.path 上,全名=收下却重载不到;
    // 线路只送 requestModule 短名,fullModule 全名仅供 UI 展示(双名不混)。
    // 双带口径(query 与 body 各一份)同送短名,缺一即红。
    expect(request.body).toBe('module_name=fight.FightAI');
    expect(request.url).toBe('http://127.0.0.1:8090/hotfix?module_name=fight.FightAI');
    // 文件不在脚本根内时如实回落包边界扫描,不编造名字
    expect(resolveDefaultHotfixModule('/elsewhere/base/Avatar.py', { scriptRoot: '/ws/scripts' })).toBe(
      'Avatar'
    );
  });

  it('HR-MOD-008 根下单层:默认拒走包边界扫描;显式 allowRootLevelStem 才直接裸短名', () => {
    // 默认(未开):root-level 拒 → 回落 ${module} 包边界扫描——scripts 目录
    // 带 __init__.py 时扫描会收 scripts 段(引擎 sys.modules 里是裸名,此名
    // 收得下却重载不到,正是本键要解的形态)
    const probe = probeFor(['/ws/scripts']);
    expect(
      resolveDefaultHotfixModule('/ws/scripts/Foo.py', { scriptRoot: '/ws/scripts', isPackageDir: probe })
    ).toBe('scripts.Foo');
    // 显式开:双名称面直接回落裸短名(=进程根直下文件的 sys.modules 形态)
    expect(
      resolveDefaultHotfixModule('/ws/scripts/Foo.py', {
        scriptRoot: '/ws/scripts',
        isPackageDir: probe,
        allowRootLevelStem: true
      })
    ).toBe('Foo');
    // 请求体/query 同面:flag on 时 module_name=Foo
    const request = buildDefaultHotfixRequest('/ws/scripts/Foo.py', {
      scriptRoot: '/ws/scripts',
      isPackageDir: probe,
      allowRootLevelStem: true
    });
    expect(request.body).toBe('module_name=Foo');
    expect(request.url).toBe('http://127.0.0.1:8090/hotfix?module_name=Foo');
  });

  it('HR-MOD-006 多根优先级:唯一最小秩根裁决,歧义拒绝回落包边界扫描', () => {
    // 根下单层文件:所选根不同则 requestModule 不同(根=root→entities.Foo;
    // 根=entities→裸名 Foo),以此真区分优先级裁决所选的根
    const file = '/ws/scripts/entities/Foo.py';
    const allowRoot = true;
    // 显式排序 [entities, root]:entities 索小=优先 → 根=entities → 根下单层裸名
    const nestedFirst = resolveDefaultHotfixModule(file, {
      scriptRoots: ['/ws/scripts', '/ws/scripts/entities'],
      rootPriority: ['/ws/scripts/entities', '/ws/scripts'],
      allowRootLevelStem: allowRoot
    });
    expect(nestedFirst).toBe('Foo');
    // 显式排序 [root, entities]:root 优先 → 根=root → entities.Foo
    const rootFirst = resolveDefaultHotfixModule(file, {
      scriptRoots: ['/ws/scripts', '/ws/scripts/entities'],
      rootPriority: ['/ws/scripts', '/ws/scripts/entities'],
      allowRootLevelStem: allowRoot
    });
    expect(rootFirst).toBe('entities.Foo');
    // 歧义(未给优先级):拒绝 → 回落 ${module} 包边界扫描(不编造,不猜)
    const ambiguous = resolveDefaultHotfixModule(file, {
      scriptRoots: ['/ws/scripts', '/ws/scripts/entities'],
      allowRootLevelStem: allowRoot
    });
    expect(ambiguous).toBe('Foo');
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

  it('HR-HTTP-008(RUST-350):已取消——ok=false,detail 带 uncertain 文案(取消≠远端撤销)', async () => {
    const controller = new AbortController();
    const result = await sendDefaultHotfix(['/ws/scripts/base/Account.py'], {
      signal: controller.signal,
      transport: () =>
        Promise.resolve({
          ok: false,
          status: 0,
          durationMs: 2,
          body: '',
          error: '请求已取消(调用方中止)'
        })
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('已取消');
    expect(result.detail).toContain('uncertain');
    expect(result.outcomes[0].kind).toBe('cancelled');
    expect(result.outcomes[0].errorCategory).toBe('cancelled');
  });

  it('HR-HTTP-008(RUST-350):信号已中止——首个文件已取消后逐文件发送即停(不再发起)', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await sendDefaultHotfix(['/a/One.py', '/a/Two.py'], {
      signal: controller.signal,
      transport: () => {
        calls += 1;
        return Promise.resolve({
          ok: false,
          status: 0,
          durationMs: 1,
          body: '',
          error: '请求已取消(调用方中止)'
        });
      }
    });
    expect(calls).toBe(1); // 首个已取消即停,第二个不再发起
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('uncertain');
  });
});

describe('HR-HTTP-002(模块身份/版本/关联 id → 结构化 outcome)', () => {
  it('显式模块身份:请求按调用方给定身份构造,不重新推导', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const result = await sendDefaultHotfix(['/ws/scripts/base/Account.py'], {
      transport: request => {
        seen.push({ url: request.url, body: request.body });
        return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
      },
      moduleIdentities: ['custom.Mod']
    });
    expect(seen[0].url).toBe('http://127.0.0.1:8090/hotfix?module_name=custom.Mod');
    expect(seen[0].body).toBe('module_name=custom.Mod');
    expect(result.ok).toBe(true);
  });

  it('buildDefaultHotfixRequest 第三参:空串视同未给,仍走推导', () => {
    const derived = buildDefaultHotfixRequest('/ws/scripts/base/Account.py');
    const explicit = buildDefaultHotfixRequest('/ws/scripts/base/Account.py', {}, 'given.Mod');
    const empty = buildDefaultHotfixRequest('/ws/scripts/base/Account.py', {}, '');
    expect(explicit.body).toBe('module_name=given.Mod');
    expect(explicit.url).toBe('http://127.0.0.1:8090/hotfix?module_name=given.Mod');
    // 空串=未给:与不传第三参同口径(推导),不拿空串冒充身份
    expect(empty.body).toBe(derived.body);
  });

  it('单文件关联 id 种子:该次执行直接用它,结果回执种子原样', async () => {
    const result = await sendDefaultHotfix(['/a/One.py'], {
      transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }),
      correlationId: 'seed-abc'
    });
    expect(result.correlationId).toBe('seed-abc');
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].correlationId).toBe('seed-abc');
  });

  it('多文件关联 id 种子:序号后缀保唯一,回执仍为种子', async () => {
    const seeded = await sendDefaultHotfix(['/a/One.py', '/a/Two.py', '/a/Three.py'], {
      transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }),
      correlationId: 'batch'
    });
    expect(seeded.correlationId).toBe('batch');
    expect(seeded.outcomes.map(o => o.correlationId)).toEqual(['batch#1', 'batch#2', 'batch#3']);
  });

  it('未给种子:各次执行自生成且互不相同,结果不回执关联 id', async () => {
    const result = await sendDefaultHotfix(['/a/One.py', '/a/Two.py'], {
      transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' })
    });
    expect(result.correlationId).toBeUndefined();
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0].correlationId.length).toBeGreaterThan(0);
    expect(result.outcomes[1].correlationId.length).toBeGreaterThan(0);
    expect(result.outcomes[0].correlationId).not.toBe(result.outcomes[1].correlationId);
  });

  it('结构化 outcome 按传输事实分类(ok/非 2xx/连接拒绝),ok-detail 语义不变', async () => {
    const ok = await sendDefaultHotfix(['/a/One.py'], {
      transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'fine' })
    });
    expect(ok.outcomes[0]).toMatchObject({ kind: 'ok', transportOk: true, status: 200 });

    const non2xx = await sendDefaultHotfix(['/a/One.py'], {
      transport: () => Promise.resolve({ ok: true, status: 503, durationMs: 1, body: 'nope' })
    });
    expect(non2xx.outcomes[0]).toMatchObject({
      kind: 'non-2xx',
      transportOk: true,
      errorCategory: 'http-status'
    });
    expect(non2xx.ok).toBe(false);
    expect(non2xx.detail).toContain('503');

    const refused = await sendDefaultHotfix(['/a/One.py'], {
      transport: () =>
        Promise.resolve({
          ok: false,
          status: 0,
          durationMs: 1,
          body: '',
          error: 'connect ECONNREFUSED 127.0.0.1:8090'
        })
    });
    expect(refused.outcomes[0]).toMatchObject({
      kind: 'network-error',
      transportOk: false,
      errorCategory: 'connection-refused'
    });
    expect(refused.detail).toContain('ECONNREFUSED');
  });

  it('版本回执:给了就原样回,不给则不携带', async () => {
    const withRevision = await sendDefaultHotfix(['/a/One.py'], {
      transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }),
      revision: 'rev-42'
    });
    expect(withRevision.revision).toBe('rev-42');
    const without = await sendDefaultHotfix(['/a/One.py'], {
      transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' })
    });
    expect(without.revision).toBeUndefined();
  });
});
