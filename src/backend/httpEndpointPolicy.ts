/**
 * RUST-420(HR-QA-008)HTTP 端点策略纯核:默认只放行确认的 loopback 目标
 * (本机引擎端点);非 loopback 需显式授权(kbengine.http.allowNonLoopback)
 * 且逐次落安全警告,未授权一律阻止。
 *
 * 与 RUST-422(HR-QA-010)工作区信任闸互补:信任闸防「配置来自不受信
 * 工作区」,本闸防「请求目的地越出本机」——即使工作区已信任,把请求发到
 * 非本机主机(内网探测/云元数据/数据外带)仍需用户显式授权。
 *
 * 分类只认 host 字面量,不做 DNS 解析:名字解析到 loopback 的公网域名仍按
 * 非 loopback 拦(保守侧,用户可显式授权放行);反向(localhost 被
 * /etc/hosts 改指别机)属机器层配置,不在插件职责内。node 传输面不跟随
 * 重定向,首请求 URL 即全部网络目的地,无重定向绕闸面。
 *
 * 零 vscode 零 IO(与 httpRequestService/httpRequestExecutor 同层纪律)。
 */

export type HttpEndpointKind = 'loopback' | 'non-loopback' | 'not-http';

export interface HttpEndpointClassification {
  readonly kind: HttpEndpointKind;
  /** URL 的 hostname(URL 解析器已小写化);not-http 时为 null */
  readonly host: string | null;
}

/** IPv4 段:1-3 位数字且 ≤255 */
const isIpv4Octet = (part: string): boolean => /^\d{1,3}$/.test(part) && Number(part) <= 255;

/** 127.0.0.0/8 整段是 IPv4 loopback(非仅 127.0.0.1) */
const isIpv4Loopback = (host: string): boolean => {
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every(isIpv4Octet);
};

/** IPv6 loopback:::1(含展开形)与 IPv4 映射形 ::ffff:127.x.x.x */
const isIpv6Loopback = (host: string): boolean => {
  const raw = (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host).toLowerCase();
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw) && raw.split('.').slice(1).every(isIpv4Octet);
};

/**
 * host 字面量是否 loopback:localhost 及其子域(RFC 6761 保留 *.localhost)
 * / 127.0.0.0/8 / [::1] / ::ffff:127.x.x.x。
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  return isIpv4Loopback(host) || isIpv6Loopback(host);
}

/**
 * URL → 端点分类。只对可解析的 http/https URL 分类(那才有网络目的地);
 * 解析失败或非 http(s) 协议(not-http)由既有传输面拒绝(invalid-url/
 * unsupported-protocol),本闸不重复裁决。
 */
export function classifyHttpEndpoint(url: string): HttpEndpointClassification {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'not-http', host: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'not-http', host: null };
  }
  const host = parsed.hostname;
  if (host.length === 0) {
    return { kind: 'not-http', host: null };
  }
  return { kind: isLoopbackHost(host) ? 'loopback' : 'non-loopback', host };
}

export interface HttpEndpointPolicyDecision {
  /** allow=放行;warn=放行但逐次落安全警告(非 loopback 已显式授权);block=阻止 */
  readonly action: 'allow' | 'warn' | 'block';
  readonly host: string | null;
  /** warn/block 时的用户可读说明;allow 为 null */
  readonly message: string | null;
}

/** 非 loopback 显式授权设置键(package.json contributes.configuration 同名) */
export const HTTP_ALLOW_NON_LOOPBACK_SETTING = 'kbengine.http.allowNonLoopback';

/**
 * 端点策略裁决(纯函数):
 * - loopback / 非 http(s) → allow(本机引擎是功能本意;非 http 由传输面拒);
 * - 非 loopback 未授权 → block(SSRF/数据外带防护,不发请求);
 * - 非 loopback 已授权 → warn(放行,安全警告随每次请求落面板)。
 */
export function decideHttpEndpoint(url: string, allowNonLoopback: boolean): HttpEndpointPolicyDecision {
  const { kind, host } = classifyHttpEndpoint(url);
  if (kind !== 'non-loopback') {
    return { action: 'allow', host, message: null };
  }
  if (!allowNonLoopback) {
    return {
      action: 'block',
      host,
      message:
        `非 loopback 端点已阻止(目标 ${host}):默认只放行本机 loopback 端点` +
        `;确需请求远端主机请显式开启 ${HTTP_ALLOW_NON_LOOPBACK_SETTING}(SSRF/数据外带防护)`
    };
  }
  return {
    action: 'warn',
    host,
    message:
      `⚠ 非 loopback 端点(已显式授权):目标 ${host} 非本机 loopback,` +
      `请求会发往该主机——仅在你信任该主机时使用`
  };
}
