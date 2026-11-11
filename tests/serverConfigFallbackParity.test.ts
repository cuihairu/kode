// `$/kode/config/resolve` Rust↔TS 回落核行为对拍(AUDIT-007)。
//
// 用真实 kode-server 二进制跑 resolve RPC,与 src/serverConfigFallbackCore
// 的回落核产物对同一 inputs 深等断言(全字段:三棵树 + telnet 速览 + 端口表
// + customTelnet + dbInterface)。断言两条:
//
// 1. **零漂移(硬断言)**:TS 回落 ≡ Rust core——回落态标注 resolver:'ts'
//   的前提是语义镜像成立,本测试是那句话的执行面;任一字段漂移即红。
// 2. **样本面**:真实 fixture(defaults+元件)与合成边界(CRLF/0x 端口/
//   encrypt=false 明文/缺段回落/flat 无包裹/纯注释/空串)全走,防「真实文件
//   相等、边界漂移」的假绿。
//
// 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏
// 纯 TS 门禁;二进制在场则跑真实 RPC(对拍语义=双实现同输入同输出)。
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { resolveConfigProductsInTs } from '../src/serverConfigFallbackCore';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);

const FIXTURES = join(repoRoot, 'tests', 'fixtures', 'config');
const realDefaults = readFileSync(join(FIXTURES, 'kbengine_defaults.xml'), 'utf8');
const realCustom = readFileSync(join(FIXTURES, 'kbengine.xml'), 'utf8');

const wrap = (body: string): string => `<root>\n${body}\n</root>\n`;

/** 合成样本:确定性覆盖提取器边界(注释/CRLF/0x/明文密码/缺段/flat 形态)。 */
const syntheticSamples: Array<{ label: string; defaultsXml: string | null; customXml: string | null }> = [
  { label: 'both-null', defaultsXml: null, customXml: null },
  { label: 'empty-strings', defaultsXml: '', customXml: '' },
  { label: 'comments-only', defaultsXml: '<!-- 只有注释 -->\n', customXml: null },
  {
    label: 'db-full',
    defaultsXml: wrap(
      '<dbmgr><databaseInterfaces><default>' +
        '<host> 10.0.0.9 </host><port> 3307 </port><databaseName> game </databaseName>' +
        '<auth><username> kbe2 </username><encrypt> false </encrypt><password> pw </password></auth>' +
        '<unicodeString><characterSet> gb2312 </characterSet></unicodeString>' +
        '</default></databaseInterfaces></dbmgr>' +
        '<baseapp><!-- 前导 --><telnet_service><port> 0 </port><password> pw </password></telnet_service></baseapp>'
    ),
    customXml: null
  },
  {
    label: 'edge-ports',
    defaultsXml: wrap(
      '<dbmgr><databaseInterfaces><default><port> 0x10 </port></default></databaseInterfaces></dbmgr>' +
        '<loginapp><telnet_service><port> 31001 </port></telnet_service></loginapp>' +
        '<bots><telnet_service><port> 51abc </port></telnet_service></bots>'
    ),
    customXml: wrap('<baseapp><entryScriptFile>local-entry</entryScriptFile><telnet_service><port> 40001 </port><password> cp </password></telnet_service></baseapp>')
  },
  {
    label: 'crlf-and-flat',
    defaultsXml: '<baseapp>\r\n\t<!-- CRLF 注释 -->\r\n\t<rate> 10 </rate>\r\n</baseapp>',
    customXml: '<baseapp>\r\n\t<rate> 20 </rate>\r\n\t<extra> 1 </extra>\r\n</baseapp>'
  },
  {
    label: 'table-replace',
    defaultsXml: wrap('<baseapp><disables><item> a </item><item> b </item></disables></baseapp>'),
    customXml: wrap('<baseapp><disables><item> 9 </item><item> b </item></disables></baseapp>')
  }
];

describe.skipIf(!binaryReady)('config resolve Rust↔TS 回落核对拍(AUDIT-007)', () => {
  it('全字段深等:真实 fixture + 合成边界,回落核 ≡ Rust core', async () => {
    const samples = [
      { label: 'real-defaults-only', defaultsXml: realDefaults, customXml: null },
      { label: 'real-pair', defaultsXml: realDefaults, customXml: realCustom },
      ...syntheticSamples
    ];
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined
    });
    await client.start();
    try {
      for (const sample of samples) {
        const rust = (await client.request('$/kode/rpc', {
          method: '$/kode/config/resolve',
          params: { defaultsXml: sample.defaultsXml, customXml: sample.customXml }
        })) as unknown;
        const ts = resolveConfigProductsInTs(sample.defaultsXml, sample.customXml);
        expect(rust, `sample ${sample.label}`).toEqual(ts);
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 30000);
});
