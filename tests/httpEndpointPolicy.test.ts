import { describe, expect, it } from 'vitest';
import {
  classifyHttpEndpoint,
  decideHttpEndpoint,
  isLoopbackHost,
  HTTP_ALLOW_NON_LOOPBACK_SETTING
} from '../src/backend/httpEndpointPolicy';

// RUST-420(HR-QA-008)端点策略纯核:host 字面量分类(零 DNS)+策略裁决。
// 保守侧原则:名字解析到 loopback 的公网域名按非 loopback 拦(用户可显式
// 授权);非 http(s)/不可解析 URL 交既有传输面拒绝,本闸不重复裁决。

describe('isLoopbackHost:host 字面量分类', () => {
  it('localhost 与 *.localhost 子域是 loopback(RFC 6761 保留)', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('foo.localhost')).toBe(true);
    expect(isLoopbackHost('sub.foo.localhost')).toBe(true);
  });

  it('IPv4 127.0.0.0/8 整段是 loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.0')).toBe(true);
    expect(isLoopbackHost('127.255.255.255')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
  });

  it('IPv6 ::1(含展开形)与 ::ffff:127.x.x.x 映射形是 loopback', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::ffff:127.9.8.7')).toBe(true);
  });

  it('非 loopback:公网/内网/链路本地/元数据地址/非 .localhost 域名/畸形', () => {
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    // 云元数据地址(SSRF 经典目标)必须非 loopback
    expect(isLoopbackHost('169.254.169.254')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('localhost.localdomain')).toBe(false);
    expect(isLoopbackHost('mylocalhost')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('[::]')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('0:0:0:0:0:0:0:2')).toBe(false);
    expect(isLoopbackHost('::ffff:8.8.8.8')).toBe(false);
  });

  it('畸形 IPv4:段数错/越界/前缀非 127 一律非 loopback', () => {
    expect(isLoopbackHost('127.0.0')).toBe(false);
    expect(isLoopbackHost('127.0.0.256')).toBe(false);
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('classifyHttpEndpoint:URL → 端点分类', () => {
  it('http/https loopback 字面量归 loopback', () => {
    expect(classifyHttpEndpoint('http://localhost:8090/hotfix')).toEqual({ kind: 'loopback', host: 'localhost' });
    expect(classifyHttpEndpoint('http://127.0.0.1:8090/x')).toEqual({ kind: 'loopback', host: '127.0.0.1' });
    expect(classifyHttpEndpoint('https://[::1]:8090/x')).toEqual({ kind: 'loopback', host: '[::1]' });
    expect(classifyHttpEndpoint('http://127.0.0.1')).toEqual({ kind: 'loopback', host: '127.0.0.1' });
    expect(classifyHttpEndpoint('http://sub.localhost:80/x')).toEqual({ kind: 'loopback', host: 'sub.localhost' });
  });

  it('非 loopback 主机归 non-loopback(内网/公网/元数据)', () => {
    expect(classifyHttpEndpoint('http://169.254.169.254/latest/meta-data/')).toEqual({
      kind: 'non-loopback',
      host: '169.254.169.254'
    });
    expect(classifyHttpEndpoint('http://10.0.0.5:8080/x')).toEqual({ kind: 'non-loopback', host: '10.0.0.5' });
    expect(classifyHttpEndpoint('https://example.com/x')).toEqual({ kind: 'non-loopback', host: 'example.com' });
  });

  it('非 http(s) 协议与不可解析 URL 归 not-http(交传输面拒绝,不重复裁决)', () => {
    expect(classifyHttpEndpoint('file:///etc/passwd')).toEqual({ kind: 'not-http', host: null });
    expect(classifyHttpEndpoint('ftp://example.com/x')).toEqual({ kind: 'not-http', host: null });
    expect(classifyHttpEndpoint('not-a-url')).toEqual({ kind: 'not-http', host: null });
    expect(classifyHttpEndpoint('http://')).toEqual({ kind: 'not-http', host: null });
  });
});

describe('decideHttpEndpoint:策略裁决', () => {
  it('loopback 无论授权与否都放行(本机引擎是功能本意)', () => {
    expect(decideHttpEndpoint('http://127.0.0.1:8090/x', false).action).toBe('allow');
    expect(decideHttpEndpoint('http://127.0.0.1:8090/x', true).action).toBe('allow');
  });

  it('非 http(s)/不可解析放行(传输面拒绝,本闸不拦)', () => {
    expect(decideHttpEndpoint('file:///etc/passwd', false).action).toBe('allow');
    expect(decideHttpEndpoint('not-a-url', false).action).toBe('allow');
  });

  it('非 loopback 未授权=阻止,消息含阻止说明与设置键', () => {
    const decision = decideHttpEndpoint('http://10.0.0.5:8080/x', false);
    expect(decision.action).toBe('block');
    expect(decision.host).toBe('10.0.0.5');
    expect(decision.message).toContain('非 loopback 端点已阻止');
    expect(decision.message).toContain(HTTP_ALLOW_NON_LOOPBACK_SETTING);
  });

  it('非 loopback 已授权=放行但逐次落安全警告', () => {
    const decision = decideHttpEndpoint('http://10.0.0.5:8080/x', true);
    expect(decision.action).toBe('warn');
    expect(decision.host).toBe('10.0.0.5');
    expect(decision.message).toContain('已显式授权');
    expect(decision.message).toContain('仅在你信任该主机时');
  });

  it('云元数据端点未授权=阻止(SSRF 经典目标)', () => {
    expect(decideHttpEndpoint('http://169.254.169.254/latest/meta-data/', false).action).toBe('block');
  });
});
