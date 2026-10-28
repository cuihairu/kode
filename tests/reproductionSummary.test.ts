import { describe, expect, it } from 'vitest';
import {
  maskConnectionSecrets,
  renderConnectionLine,
  renderReproductionSummary,
  type ReproductionSummaryInput
} from '../src/reproductionSummary';

// IDE-REL-007 诊断报告导出复现配置摘要:纯渲染面——活动版本/根/角色
// (宿主角色=local|remote + 扩展宿主侧)/开关/队列数据五节如实渲染,连接
// 信息两层遮蔽(连接行显式遮蔽 username/password + 全文兜底
// maskConnectionSecrets:password/token 等赋值与 URL userinfo 一律 ***)。

function makeInput(overrides: Partial<ReproductionSummaryInput> = {}): ReproductionSummaryInput {
  return {
    host: { label: 'local', side: 'workspace host' },
    extensions: [
      { id: 'cuihairu.kode-kbengine', version: '0.2.0', active: true, side: 'workspace host' }
    ],
    buildCommit: '5d5e4b026b159923353a8f88f758d0ac98ddeb38',
    workspaceFolders: ['/tmp/ws'],
    scanRoots: ['/tmp/ws', '/tmp/external'],
    profile: { name: 'demo', assetsRoot: '/tmp/ws', engineRoot: '/tmp/engine' },
    switches: [
      { key: 'kbengine.enableDiagnostics', on: true },
      { key: 'kbengine.jumpLog', on: false }
    ],
    queue: {
      diagnosticsQueued: 2,
      diagnosticsInFlight: 1,
      annotationUpdates: 3,
      indexTasksQueued: 4,
      schemaColdBuilds: 0
    },
    activeOperations: { hover: 2, 'semantic-query': 1 },
    connections: [
      {
        source: 'engine-dbmgr',
        host: 'db1.internal',
        port: 3306,
        username: 'kbe',
        databaseName: 'kbe',
        encrypt: false
      }
    ],
    ...overrides
  };
}

describe('连接信息遮蔽(IDE-REL-007)', () => {
  it('赋值形态的 password/token/secret/authorization 值替换为 ***', () => {
    expect(maskConnectionSecrets('password=hunter2')).toBe('password=***');
    expect(maskConnectionSecrets('token: "abc def"')).toBe('token: ***');
    expect(maskConnectionSecrets('x secret=\'p@ss\' y')).toBe('x secret=*** y');
    expect(maskConnectionSecrets('authorization=Bearer zzz,next')).toBe('authorization=***,next');
  });

  it('URL userinfo 整段遮蔽,主机端口保留', () => {
    expect(maskConnectionSecrets('mysql://root:s3cret@db1:3306/kbe'))
      .toBe('mysql://***@db1:3306/kbe');
    expect(maskConnectionSecrets('postgresql://admin@pg1/db')).toBe('postgresql://***@pg1/db');
  });

  it('普通路径与无关文本不受影响', () => {
    expect(maskConnectionSecrets('/home/cui/workspaces/kode assets=/tmp/ws'))
      .toBe('/home/cui/workspaces/kode assets=/tmp/ws');
  });

  it('连接行显式遮蔽 username/password,保留 host/port/database/encrypt', () => {
    const line = renderConnectionLine({
      source: 'engine-dbmgr',
      host: 'db1.internal',
      port: 3306,
      username: 'kbe',
      databaseName: 'kbe',
      encrypt: false
    });
    expect(line).toContain('host=db1.internal');
    expect(line).toContain('port=3306');
    expect(line).toContain('database=kbe');
    expect(line).toContain('encrypt=false');
    expect(line).toContain('username=***');
    expect(line).toContain('password=***');
    expect(line).not.toContain('kbe@');
    expect(line.match(/kbe/g)?.length).toBe(1); // databaseName 的 kbe 保留,username 值不出现
  });
});

describe('复现配置摘要渲染(IDE-REL-007)', () => {
  it('五节俱全:角色/活动版本/根/开关/队列,连接行已遮蔽', () => {
    const text = renderReproductionSummary(makeInput());
    expect(text).toContain('宿主角色: local(workspace host)');
    expect(text).toContain('cuihairu.kode-kbengine@0.2.0 active=yes side=workspace host');
    expect(text).toContain('构建提交: 5d5e4b026b159923353a8f88f758d0ac98ddeb38');
    expect(text).toContain('workspace: /tmp/ws');
    expect(text).toContain('scan: /tmp/external');
    expect(text).toContain('profile: demo assets=/tmp/ws engine=/tmp/engine');
    expect(text).toContain('kbengine.enableDiagnostics: on');
    expect(text).toContain('kbengine.jumpLog: off');
    expect(text).toContain('诊断排队=2');
    expect(text).toContain('诊断在途=1');
    expect(text).toContain('注解待更新=3');
    expect(text).toContain('索引任务=4');
    expect(text).toContain('schema冷构建=0');
    expect(text).toContain('hover=2');
    expect(text).toContain('semantic-query=1');
    expect(text).toContain('host=db1.internal');
    expect(text).not.toContain('username=kbe');
  });

  it('空态如实:无扩展/无 profile/无连接/无在册操作各给显式空态行', () => {
    const text = renderReproductionSummary(makeInput({
      extensions: [],
      profile: null,
      connections: [],
      activeOperations: {}
    }));
    expect(text).toContain('无 cuihairu. 名下扩展');
    expect(text).toContain('profile: 无(未选择活动 profile)');
    expect(text).toContain('连接: 无(未解析到引擎数据库连接)');
    expect(text).toContain('在册操作: 无');
  });

  it('全文兜底:任意字段里混入凭据形态文本也会被遮蔽', () => {
    const text = renderReproductionSummary(makeInput({
      profile: { name: 'demo password=hunter2', assetsRoot: '/tmp/ws', engineRoot: '/tmp/engine' }
    }));
    expect(text).not.toContain('hunter2');
    expect(text).toContain('password=***');
  });

  it('多个扩展与多个根逐行列出,顺序保持输入序', () => {
    const text = renderReproductionSummary(makeInput({
      extensions: [
        { id: 'cuihairu.kode-kbengine', version: '0.2.0', active: true, side: 'workspace host' },
        { id: 'cuihairu.other', version: '1.0.0', active: false, side: 'ui host' }
      ],
      scanRoots: ['/a', '/b', '/c']
    }));
    expect(text.indexOf('cuihairu.kode-kbengine@0.2.0')).toBeLessThan(text.indexOf('cuihairu.other@1.0.0'));
    expect(text).toContain('active=no');
    expect(text).toContain('scan: /a');
    expect(text).toContain('scan: /b');
    expect(text).toContain('scan: /c');
  });
});
