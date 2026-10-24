import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  CELLAPPMGR_QUERY_SPACES_MSG_ID,
  CONSOLE_PROFILE_CB_MSG_ID,
  CONSOLE_WATCHER_CB_MSG_ID
} from '../src/kbengineProtocol';

// C-11(V-08)边界注记 + 回执消息号勘误的防漂移锁。取证文档最初把 watcher 线
// 回执误记为 65503(根因:Watcher.py 同文件里两个常量都定义了,取错了一个);
// 引擎真值是 watcher 走 65502(console_helper.h:11 CONSOLE_WATCHERCB_MSGID)、
// SpaceViewer/负载线走 65503。本锁钉死:① 中英两份文档逐字节一致;
// ② 文档回执号与 src/kbengineProtocol.ts 导出常量互相印证;③ 「两条线共用
// 一个回执号」的失实表述不得回潮;④ WATCHER_QUERY_MSG_IDS 必须是 41001-41008
// 整段 8 号(与引擎 Watcher.py:33-40 一一对应);⑤ V-08 边界注记在两份文档
// 都在,且三条重开触发条件与钩子条目齐全——外部条件没满足前不得写成已接通。

const root = join(__dirname, '..');
const docPath = join(root, 'docs', 'design', 'space-viewer-watcher.md');
const zhDocPath = join(root, 'docs', 'zh', 'design', 'space-viewer-watcher.md');
const doc = readFileSync(docPath, 'utf8');
const zhDoc = readFileSync(zhDocPath, 'utf8');
const protocolSource = readFileSync(join(root, 'src', 'kbengineProtocol.ts'), 'utf8');

// 回执不是最后一列(后面还有语义列),所以不锚 $,只吃两列
const watcherRow = doc.match(/^\| Watcher \| `41001`–`(\d+)`[^|]*\| `(\d+)` \|/m);
const spaceViewerRow = doc.match(/^\| SpaceViewer \| `50001`–`(\d+)` \| `(\d+)` \|/m);

const watcherQueryIds = (): number[] => {
  const block = protocolSource.match(/const WATCHER_QUERY_MSG_IDS[^{]*\{([\s\S]*?)\};/);
  expect(block, 'WATCHER_QUERY_MSG_IDS 表应在 src/kbengineProtocol.ts 中').toBeDefined();
  return [...((block as RegExpMatchArray)[1]).matchAll(/:\s*(\d+)/g)].map(match => Number(match[1]));
};

describe('watcher 协议取证文档与代码互证', () => {
  it('中英两份取证文档逐字节一致(镜像约定)', () => {
    expect(zhDoc).toBe(doc);
  });

  it('回执消息号与 src/kbengineProtocol.ts 常量互相印证(watcher=65502, viewer=65503)', () => {
    expect(watcherRow, '协议线总表应有 Watcher 行').not.toBeNull();
    expect(spaceViewerRow, '协议线总表应有 SpaceViewer 行').not.toBeNull();
    expect(Number(watcherRow?.[1])).toBe(41008);
    expect(Number(watcherRow?.[2])).toBe(CONSOLE_WATCHER_CB_MSG_ID);
    expect(Number(spaceViewerRow?.[1])).toBe(50005);
    expect(Number(spaceViewerRow?.[2])).toBe(CONSOLE_PROFILE_CB_MSG_ID);
    expect(CELLAPPMGR_QUERY_SPACES_MSG_ID).toBe(50003);
  });

  it('「两条线共用同一回执号」的失实表述不得回潮', () => {
    expect(doc).not.toContain('共用同一个回执消息号');
    expect(doc).toContain('两条线**回执消息号不同**');
  });

  it('WATCHER_QUERY_MSG_IDS 覆盖 41001-41008 整段 8 号,与文档行互证', () => {
    const ids = watcherQueryIds();
    expect(ids.sort((a, b) => a - b)).toEqual([41001, 41002, 41003, 41004, 41005, 41006, 41007, 41008]);
  });
});

describe('V-08 边界注记', () => {
  it('两份文档都有边界注记小节,标题锚定外部条件', () => {
    for (const text of [doc, zhDoc]) {
      expect(text).toContain('## 8. V-08 边界注记：真实管理协议（外部条件）');
    }
  });

  it('三条重开触发条件(可达实例/消息号对账/版本可判定)条目齐全', () => {
    const section = doc.slice(doc.indexOf('## 8. V-08 边界注记'));
    for (const trigger of ['**可达实例**', '**消息号表对账通过**', '**版本可判定**']) {
      expect(section, `边界注记缺触发条件: ${trigger}`).toContain(trigger);
    }
  });

  it('注记只声明已留好的钩子:引用的常量与组帧函数在源码中真实存在', () => {
    const section = doc.slice(doc.indexOf('## 8. V-08 边界注记'));
    expect(section).toContain('src/kbengineProtocol.ts:54-58');
    expect(section).toContain('src/kbengineProtocol.ts:80-89');
    expect(section).toContain('src/kbengineProtocol.ts:283');
    // 钩子引用的行号锚点必须仍指向真实内容(行号漂移即视为文档失实)
    const lines = protocolSource.split('\n');
    expect(lines[53]).toContain('CONSOLE_WATCHER_CB_MSG_ID = 65502');
    expect(lines[79]).toContain('WATCHER_QUERY_MSG_IDS');
    expect(lines[282]).toContain('export function buildFrame');
  });

  it('边界注记不把外部条件写成已满足(不宣称端到端已接通)', () => {
    const section = doc.slice(doc.indexOf('## 8. V-08 边界注记'));
    expect(section).toContain('不硬造实现');
    expect(section).not.toMatch(/端到端(已|已经)(接通|打通|可用)/);
  });
});
