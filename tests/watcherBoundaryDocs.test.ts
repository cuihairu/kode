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
// SpaceViewer/负载线走 65503。本锁钉死:① zh 版是逐字中文原文、根级是其忠实
// 英文译文(双语对调后的成对契约,取代旧的逐字节镜像约定);② 两份文档的回执
// 消息号行都与 src/kbengineProtocol.ts 导出常量互相印证;③ 「两条线共用一个
// 回执号」的失实表述在任一语言都不得回潮;④ WATCHER_QUERY_MSG_IDS 必须是
// 41001-41008 整段 8 号(与引擎 Watcher.py:33-40 一一对应);⑤ V-08 边界注记在
// 两份文档都在,三条重开触发条件与钩子条目齐全——外部条件没满足前不得写成
// 已接通。

const root = join(__dirname, '..');
const docPath = join(root, 'docs', 'design', 'space-viewer-watcher.md');
const zhDocPath = join(root, 'docs', 'zh', 'design', 'space-viewer-watcher.md');
const doc = readFileSync(docPath, 'utf8');
const zhDoc = readFileSync(zhDocPath, 'utf8');
const protocolSource = readFileSync(join(root, 'src', 'kbengineProtocol.ts'), 'utf8');

const versions: Array<{ label: string; text: string; lang: 'en' | 'zh' }> = [
  { label: 'en(root)', text: doc, lang: 'en' },
  { label: 'zh', text: zhDoc, lang: 'zh' }
];

// 回执不是最后一列(后面还有语义列),所以不锚 $,只吃两列
const watcherRow = (text: string) =>
  text.match(/^\| Watcher \| `41001`–`(\d+)`[^|]*\| `(\d+)` \|/m);
const spaceViewerRow = (text: string) =>
  text.match(/^\| SpaceViewer \| `50001`–`(\d+)` \| `(\d+)` \|/m);

const watcherQueryIds = (): number[] => {
  const block = protocolSource.match(/const WATCHER_QUERY_MSG_IDS[^{]*\{([\s\S]*?)\};/);
  expect(block, 'WATCHER_QUERY_MSG_IDS 表应在 src/kbengineProtocol.ts 中').toBeDefined();
  return [...((block as RegExpMatchArray)[1]).matchAll(/:\s*(\d+)/g)].map(match => Number(match[1]));
};

describe('watcher 协议取证文档与代码互证', () => {
  it('zh 版保留中文原文、根级是英文译文(双语成对契约)', () => {
    expect(zhDoc).toContain('# G9 Space Viewer / Watcher 面板 · 引擎协议取证');
    expect(doc).toContain('# G9 Space Viewer / Watcher Panel · Engine Protocol Forensics');
    expect(zhDoc).toContain('## 1. 两条协议线');
    expect(doc).toContain('## 1. The two protocol lines');
  });

  it('回执消息号与 src/kbengineProtocol.ts 常量互相印证(watcher=65502, viewer=65503, 两份文档逐份核对)', () => {
    for (const { label, text } of versions) {
      const wRow = watcherRow(text);
      const svRow = spaceViewerRow(text);
      expect(wRow, `${label}: 协议线总表应有 Watcher 行`).not.toBeNull();
      expect(svRow, `${label}: 协议线总表应有 SpaceViewer 行`).not.toBeNull();
      expect(Number(wRow?.[1])).toBe(41008);
      expect(Number(wRow?.[2])).toBe(CONSOLE_WATCHER_CB_MSG_ID);
      expect(Number(svRow?.[1])).toBe(50005);
      expect(Number(svRow?.[2])).toBe(CONSOLE_PROFILE_CB_MSG_ID);
    }
    expect(CELLAPPMGR_QUERY_SPACES_MSG_ID).toBe(50003);
  });

  it('「两条线共用同一回执号」的失实表述不得回潮(任一语言)', () => {
    expect(doc).not.toContain('share the same receipt message number');
    expect(doc).toContain('use **different receipt message numbers**');
    expect(zhDoc).not.toContain('共用同一个回执消息号');
    expect(zhDoc).toContain('两条线**回执消息号不同**');
  });

  it('WATCHER_QUERY_MSG_IDS 覆盖 41001-41008 整段 8 号,与文档行互证', () => {
    const ids = watcherQueryIds();
    expect(ids.sort((a, b) => a - b)).toEqual([41001, 41002, 41003, 41004, 41005, 41006, 41007, 41008]);
  });
});

describe('V-08 边界注记', () => {
  it('两份文档都有边界注记小节,标题锚定外部条件', () => {
    expect(doc).toContain('## 8. V-08 boundary note: the real management protocol (external conditions)');
    expect(zhDoc).toContain('## 8. V-08 边界注记：真实管理协议（外部条件）');
  });

  it('三条重开触发条件(可达实例/消息号对账/版本可判定)条目齐全', () => {
    const en = doc.slice(doc.indexOf('## 8. V-08 boundary note'));
    for (const trigger of ['**A reachable instance**', '**Message-number table reconciliation passes**', '**Version determinable**']) {
      expect(en, `边界注记(en)缺触发条件: ${trigger}`).toContain(trigger);
    }
    const zh = zhDoc.slice(zhDoc.indexOf('## 8. V-08 边界注记'));
    for (const trigger of ['**可达实例**', '**消息号表对账通过**', '**版本可判定**']) {
      expect(zh, `边界注记(zh)缺触发条件: ${trigger}`).toContain(trigger);
    }
  });

  it('注记只声明已留好的钩子:引用的常量与组帧函数在源码中真实存在', () => {
    for (const text of [doc, zhDoc]) {
      const start = Math.max(text.indexOf('## 8. V-08 boundary note'), text.indexOf('## 8. V-08 边界注记'));
      expect(start, '两份文档都应有 V-08 边界注记小节').toBeGreaterThan(0);
      const section = text.slice(start);
      expect(section).toContain('src/kbengineProtocol.ts:54-58');
      expect(section).toContain('src/kbengineProtocol.ts:113-122');
      expect(section).toContain('src/kbengineProtocol.ts:316');
    }
    // 钩子引用的行号锚点必须仍指向真实内容(行号漂移即视为文档失实)
    const lines = protocolSource.split('\n');
    expect(lines[53]).toContain('CONSOLE_WATCHER_CB_MSG_ID = 65502');
    expect(lines[112]).toContain('WATCHER_QUERY_MSG_IDS');
    expect(lines[315]).toContain('export function buildFrame');
  });

  it('边界注记不把外部条件写成已满足(不宣称端到端已接通)', () => {
    const en = doc.slice(doc.indexOf('## 8. V-08 boundary note'));
    expect(en).toContain('no implementation is fabricated');
    expect(en).not.toMatch(/end-to-end\s+(assertions?|runs?)?\s*(is |are )?already\s+(wired|working|connected|live)/i);
    const zh = zhDoc.slice(zhDoc.indexOf('## 8. V-08 边界注记'));
    expect(zh).toContain('不硬造实现');
    expect(zh).not.toMatch(/端到端(已|已经)(接通|打通|可用)/);
  });
});
