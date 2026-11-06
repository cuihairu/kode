import { describe, expect, it } from 'vitest';
import { eventCallScanCountForTests, resetEventCallCacheForTests } from '../src/eventApi';
import {
  getDataDictAccessInCodeContext,
  getKbeDataDictAccessAtPosition
} from '../src/globalDataIndex';
import { getKbeAliases } from '../src/kbeModuleIndex';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { Position, makeTextDocument } from './helpers/vscodeStub';

// KR-AUD-65(UI-16)悬停侧两处口径/性能问题:
// (1) 数据字典落点判定:hover 走行级 getKbeDataDictAccessAtPosition,definition
//     走全文词法上下文 getDataDictAccessInCodeContext——同一位置(跨行三引号/
//     外层字符串里的伪访问)hover 会接管而 F12 不跳,行为不一致。验收要求两者
//     同源;
// (2) 每次悬停都全文正则扫描事件调用(findEventCalls)——同文档同版本应命中
//     缓存,版本前进才重扫。

const dictIndexStub = (sites: unknown[]): unknown =>
  ({ ensureStarted: () => Promise.resolve(), query: () => sites });

const pyDoc = (text: string, version?: number) =>
  makeTextDocument(text, {
    fileName: '/tmp/ws/scripts/Hero.py',
    languageId: 'python',
    ...(version === undefined ? {} : { version })
  });

/** 行内 `'key'` 的键内列(与 provider 定位口径一致:keyStart..keyEnd) */
const keyColumn = (line: string, key: string): number => line.indexOf(`'${key}'`) + 2;

describe('KR-AUD-65: hover 与 definition 的数据字典落点口径同源', () => {
  const TRIPLE_QUOTED = [
    'import KBEngine',
    'note = """',
    "KBEngine.globalData['cfg'] = 1",
    '"""'
  ].join('\n');
  const KEY_LINE = TRIPLE_QUOTED.split('\n')[2];
  const KEY_POS = new Position(2, keyColumn(KEY_LINE, 'cfg'));
  const ALIASES = getKbeAliases(TRIPLE_QUOTED);

  it('三引号里的伪访问:定义侧口径判非代码,行级口径会命中(不一致根源)', () => {
    expect(getDataDictAccessInCodeContext(TRIPLE_QUOTED, 2, KEY_POS.character, ALIASES))
      .toBeNull();
    expect(getKbeDataDictAccessAtPosition(KEY_LINE, KEY_POS.character, ALIASES))
      .not.toBeNull();
  });

  it('hover 不再接管三引号里的伪数据字典键(与 definition同判 null)', async () => {
    const provider = new KBEngineHoverProvider(undefined, dictIndexStub([
      { kind: 'write', valueText: '1', file: '/tmp/ws/scripts/a.py', line: 1 }
    ]) as never);
    const hover = await provider.provideHover(
      pyDoc(TRIPLE_QUOTED, 1) as never,
      KEY_POS
    );
    expect(hover === null || hover === undefined).toBe(true);
  });

  it('真实代码域写点的数据字典悬停不受影响(仍接管)', async () => {
    const text = ['import KBEngine', "KBEngine.globalData['cfg'] = 1"].join('\n');
    const line = text.split('\n')[1];
    const provider = new KBEngineHoverProvider(undefined, dictIndexStub([
      { kind: 'write', valueText: '1', file: '/tmp/ws/scripts/a.py', line: 1 }
    ]) as never);
    const hover = await provider.provideHover(
      pyDoc(text, 1) as never,
      new Position(1, keyColumn(line, 'cfg'))
    );
    expect(hover).not.toBeNull();
    expect(hover).toBeDefined();
  });

  it('行内注释里的伪访问同样不再接管(口径统一后由词法掩码统一判)', async () => {
    const text = [
      'import KBEngine',
      "cfg = 1  # KBEngine.globalData['cfg'] = 99"
    ].join('\n');
    const line = text.split('\n')[1];
    const provider = new KBEngineHoverProvider(undefined, dictIndexStub([
      { kind: 'write', valueText: '99', file: '/tmp/ws/scripts/a.py', line: 1 }
    ]) as never);
    const hover = await provider.provideHover(
      pyDoc(text, 1) as never,
      new Position(1, keyColumn(line, 'cfg'))
    );
    expect(hover === null || hover === undefined).toBe(true);
  });
});

describe('KR-AUD-65: 事件调用扫描按文档版本缓存', () => {
  const EVENT_DOC = [
    "addEvent('ready', self.onReady)",
    "emitEvent('ready')"
  ].join('\n');
  const EVENT_POS = new Position(0, 11);

  it('同文档同版本多次悬停只全文扫描一次,版本前进才重扫', async () => {
    resetEventCallCacheForTests();
    const provider = new KBEngineHoverProvider();
    const document = pyDoc(EVENT_DOC, 1);

    const first = await provider.provideHover(document as never, EVENT_POS);
    expect(first).not.toBeNull();
    expect(first).toBeDefined();
    expect(eventCallScanCountForTests()).toBe(1);

    await provider.provideHover(document as never, EVENT_POS);
    expect(eventCallScanCountForTests()).toBe(1);

    document.version = 2;
    await provider.provideHover(document as never, EVENT_POS);
    expect(eventCallScanCountForTests()).toBe(2);
  });

  it('不同文档不共享缓存(键含文档身份)', async () => {
    resetEventCallCacheForTests();
    const provider = new KBEngineHoverProvider();
    const other = makeTextDocument(EVENT_DOC, {
      fileName: '/tmp/ws/scripts/Other.py',
      languageId: 'python',
      version: 1
    });

    await provider.provideHover(pyDoc(EVENT_DOC, 1) as never, EVENT_POS);
    await provider.provideHover(other as never, EVENT_POS);
    expect(eventCallScanCountForTests()).toBe(2);
  });
});
