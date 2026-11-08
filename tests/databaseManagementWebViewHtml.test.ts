import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderConnectionSummary,
  renderKeyList,
  renderTableListRows,
  renderDatabaseManagementWebview,
  type DatabaseManagementProfileSummary
} from '../src/databaseManagementWebViewHtml';
import { strings } from '../src/webviewStrings';

// 数据库管理 WebView HTML 半边(KR-AUD-50/53 安全判据 + 渲染辅助):
// - 整页 nonce CSP(default-src 'none',脚本只认 nonce+cspSource,无 unsafe-inline);
// - 静态字符串面全量转义(host/databaseName/表名/键名标签注入不产生标签);
// - JS 侧动态数据 textContent 渲染(此处验证静态侧双保险,动态侧见控制器测)。

const t = strings('zh').databaseManagement;

const summary = (over: Partial<DatabaseManagementProfileSummary> = {}): DatabaseManagementProfileSummary => ({
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  databaseName: 'kbe',
  characterSet: 'utf8',
  encrypt: false,
  passwordAvailable: true,
  ...over
});

describe('databaseManagementWebViewHtml.escapeHtml', () => {
  it('escapes < > & "', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('a & b "c"')).toBe('a &amp; b &quot;c&quot;');
  });
});

describe('databaseManagementWebViewHtml.renderConnectionSummary', () => {
  it('renders host:port/database/user/charset/password rows', () => {
    const html = renderConnectionSummary(summary(), t);
    expect(html).toContain('127.0.0.1:3306');
    expect(html).toContain('kbe');
    expect(html).toContain('root');
    expect(html).toContain('utf8');
  });

  it('escapes malicious host/databaseName (标签注入)', () => {
    const html = renderConnectionSummary(
      summary({ host: '<img src=x onerror=alert(1)>', databaseName: '</script><script>alert(2)</script>' }),
      t
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('shows password warning when unavailable', () => {
    const html = renderConnectionSummary(summary({ passwordAvailable: false }), t);
    expect(html).toContain('密码不可读');
  });
});

describe('databaseManagementWebViewHtml.renderTableListRows', () => {
  it('renders rows and escapes malicious table names', () => {
    const html = renderTableListRows(['tbl_Account', '<img src=x onerror=alert(1)>'], t.emptyTables);
    expect(html).toContain('tbl_Account');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('empty list -> empty note', () => {
    expect(renderTableListRows([], t.emptyTables)).toContain(t.emptyTables);
  });
});

describe('databaseManagementWebViewHtml.renderKeyList', () => {
  it('renders keys and escapes malicious key names', () => {
    const html = renderKeyList(
      ['kbe_entitylog:1:2', '<script>alert(1)</script>'],
      false,
      t.emptyKeys,
      t.keysTruncated
    );
    expect(html).toContain('kbe_entitylog:1:2');
    expect(html).not.toContain('<script>');
  });

  it('truncated -> truncation note', () => {
    const html = renderKeyList([], true, t.emptyKeys, t.keysTruncated);
    expect(html).toContain(t.keysTruncated);
  });
});

describe('databaseManagementWebViewHtml.renderDatabaseManagementWebview', () => {
  const opts = (over: Partial<Parameters<typeof renderDatabaseManagementWebview>[0]> = {}) => ({
    dbType: 'mysql' as const,
    profile: null,
    nonce: 'abc123',
    cspSource: 'vscode-webview:',
    ...over
  });

  it('整页 nonce CSP:default-src none,无 unsafe-inline,无 CDN', () => {
    const html = renderDatabaseManagementWebview(opts());
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-abc123' vscode-webview:;");
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).toContain('<script nonce="abc123">');
    expect(html).not.toContain('cdn.jsdelivr');
    expect(html).not.toContain('<script src="http');
  });

  it('恶意 profile 整页渲染无注入标签', () => {
    const html = renderDatabaseManagementWebview(
      opts({
        dbType: 'mysql',
        profile: summary({
          host: '<img src=x onerror=alert(1)>',
          username: '</script><script>alert(2)</script>',
          databaseName: '<b>bold</b>'
        })
      })
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>alert(2)');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('无档案(dbType=none)出「无档案」注记且按钮禁能', () => {
    const html = renderDatabaseManagementWebview(opts({ dbType: 'none' }));
    expect(html).toContain('未读取到引擎数据库档案');
    expect(html).toContain('disabled');
  });

  it('lang 属性正确', () => {
    const html = renderDatabaseManagementWebview(opts());
    expect(html).toMatch(/<html lang="[a-zA-Z-]+">/);
  });
});
