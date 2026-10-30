import { describe, expect, it } from 'vitest';
import { dedupeSshHosts, isWildcardHostPattern, parseSshConfig } from '../src/sshConfig';

// IDE-PDBG-004 ~/.ssh/config 解析:Host 块收 HostName/User/Port/ProxyJump,
// 两种键值形(空格/等号)、多别名、通配模板剔除、块外散键忽略、去重。

describe('parseSshConfig', () => {
  it('Host 块收四键,空格与等号两种形都认,注释剥掉', () => {
    const text = [
      '# 顶部注释',
      'Host bastion',
      '  HostName 10.0.0.1   # 行尾注释',
      '  User dev',
      '  Port 2222',
      '  ProxyJump jump1,jump2',
      '',
      'Host plain',
      '  HostName=192.168.1.5',
      '  User=ops',
    ].join('\n');
    const entries = parseSshConfig(text);
    expect(entries).toEqual([
      { host: 'bastion', hostname: '10.0.0.1', user: 'dev', port: 2222, proxyJump: 'jump1,jump2' },
      { host: 'plain', hostname: '192.168.1.5', user: 'ops', port: undefined, proxyJump: undefined }
    ]);
  });

  it('Host 行多别名:逐别名各立一条,参数共享', () => {
    const entries = parseSshConfig(['Host web1 web2', '  HostName 10.1.1.1'].join('\n'));
    expect(entries.map(entry => entry.host)).toEqual(['web1', 'web2']);
    expect(entries.every(entry => entry.hostname === '10.1.1.1')).toBe(true);
  });

  it('通配模板与 negated 别名不列(不是具体主机)', () => {
    const entries = parseSshConfig(['Host *', '  User root', '', 'Host !bad', '', 'Host real'].join('\n'));
    expect(entries.map(entry => entry.host)).toEqual(['real']);
    expect(isWildcardHostPattern('*')).toBe(true);
    expect(isWildcardHostPattern('web?')).toBe(true);
    expect(isWildcardHostPattern('web1')).toBe(false);
  });

  it('Host 块之外的散键不属任何主机,忽略', () => {
    const entries = parseSshConfig(['User orphan', 'Port 1', 'Host late', '  User ok'].join('\n'));
    expect(entries).toEqual([{ host: 'late', hostname: undefined, user: 'ok', port: undefined, proxyJump: undefined }]);
  });

  it('Port 非法值(0/65536/非数)不收,其余键照收', () => {
    const entries = parseSshConfig(['Host a', '  Port 0', 'Host b', '  Port 70000', 'Host c', '  Port 22'].join('\n'));
    expect(entries.map(entry => entry.port)).toEqual([undefined, undefined, 22]);
  });

  it('无分隔空白符的行忽略(非键值形不解析)', () => {
    const entries = parseSshConfig(['Host a', '  HostName', 'bareword', '  User ok'].join('\n'));
    expect(entries).toEqual([{ host: 'a', hostname: undefined, user: 'ok', port: undefined, proxyJump: undefined }]);
  });

  it('dedupe:同别名后块补缺不覆盖已有,输出按别名排序', () => {
    const entries = parseSshConfig([
      'Host zeta',
      '  HostName 1.1.1.1',
      'Host alpha',
      '  User u',
      'Host zeta',
      '  User late',
    ].join('\n'));
    const deduped = dedupeSshHosts(entries);
    expect(deduped.map(entry => entry.host)).toEqual(['alpha', 'zeta']);
    const zeta = deduped.find(entry => entry.host === 'zeta');
    expect(zeta?.hostname).toBe('1.1.1.1'); // 前块已有,不覆盖
    expect(zeta?.user).toBe('late');        // 前块没有,后块补
  });
});
