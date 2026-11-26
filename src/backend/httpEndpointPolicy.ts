/**
 * RUST-420 (HR-QA-008) HTTP endpoint policy pure core: by default only
 * confirmed loopback targets (the local engine endpoint) are allowed; a
 * non-loopback target needs explicit authorization
 * (kbengine.http.allowNonLoopback) plus a security warning recorded per
 * request, and anything unauthorized is blocked.
 *
 * Complementary to the RUST-422 (HR-QA-010) workspace trust gate: the trust
 * gate guards against "the config coming from an untrusted workspace", while
 * this gate guards against "the request destination leaving this machine" --
 * even with the workspace trusted, sending a request to a non-local host
 * (intranet probing / cloud metadata / data exfiltration) still needs
 * explicit user authorization.
 *
 * Classification only looks at the host literal and never does DNS
 * resolution: a public domain that resolves to loopback is still blocked as
 * non-loopback (the conservative side; the user can explicitly authorize
 * it); the reverse case (localhost redirected to another machine via
 * /etc/hosts) is machine-level configuration outside the extension's
 * responsibility. The node transport surface does not follow redirects, so
 * the first request URL is the entire network destination and there is no
 * redirect route around the gate.
 *
 * Zero vscode, zero IO (the same layer discipline as
 * httpRequestService/httpRequestExecutor).
 */

export type HttpEndpointKind = 'loopback' | 'non-loopback' | 'not-http';

export interface HttpEndpointClassification {
  readonly kind: HttpEndpointKind;
  /** The URL's hostname (already lowercased by the URL parser); null for not-http */
  readonly host: string | null;
}

/** IPv4 octet: 1-3 digits and <= 255 */
const isIpv4Octet = (part: string): boolean => /^\d{1,3}$/.test(part) && Number(part) <= 255;

/** The whole 127.0.0.0/8 range is IPv4 loopback (not just 127.0.0.1) */
const isIpv4Loopback = (host: string): boolean => {
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every(isIpv4Octet);
};

/** IPv6 loopback ::1 (including the expanded form) and the IPv4-mapped form ::ffff:127.x.x.x */
const isIpv6Loopback = (host: string): boolean => {
  const raw = (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host).toLowerCase();
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw) && raw.split('.').slice(1).every(isIpv4Octet);
};

/**
 * Whether the host literal is loopback: localhost and its subdomains (RFC
 * 6761 reserves *.localhost) / 127.0.0.0/8 / [::1] / ::ffff:127.x.x.x.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  return isIpv4Loopback(host) || isIpv6Loopback(host);
}

/**
 * URL -> endpoint classification. Only parseable http/https URLs are
 * classified (only those have a network destination); a parse failure or a
 * non-http(s) protocol (not-http) is rejected by the existing transport
 * surface (invalid-url / unsupported-protocol), and this gate does not
 * adjudicate it again.
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
  /** allow = let through; warn = let through but record a security warning per request (non-loopback explicitly authorized); block = stop it */
  readonly action: 'allow' | 'warn' | 'block';
  readonly host: string | null;
  /** A user-readable explanation for warn/block; null for allow */
  readonly message: string | null;
}

/** The non-loopback explicit-authorization setting key (same name under package.json contributes.configuration) */
export const HTTP_ALLOW_NON_LOOPBACK_SETTING = 'kbengine.http.allowNonLoopback';

/**
 * Endpoint policy verdict (pure function):
 * - loopback / not http(s) -> allow (the local engine is the feature's very
 *   intent; non-http is rejected by the transport surface);
 * - non-loopback, unauthorized -> block (SSRF / data-exfiltration protection,
 *   no request sent);
 * - non-loopback, authorized -> warn (let through; the security warning lands
 *   on the panel with every request).
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
