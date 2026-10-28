import { describe, expect, it } from 'vitest';
import {
  WATCHER_CB_PROTOCOL_AUDIT,
  WATCHER_MESSAGE_PROTOCOL_AUDIT,
  WATCHER_PROTOCOL_AUDIT_VERSION,
  verifyWatcherProtocolAgainstAudit
} from '../src/watcherProtocolAudit';
import { COMPONENT_NAMES, CONSOLE_WATCHER_CB_MSG_ID, WATCHER_QUERY_MSG_IDS } from '../src/kbengineProtocol';

// IDE-LIV-002 核对一个目标版本的 watcher 协议号:逐条核对记录=组件类
// 型 → 请求号 → 引擎源码段名(kbe/res/server/messages_fixed_defaults.xml
// @ f85ad81 的 <X::queryWatcher> 段),回包号 65502 → console_helper.h
// 的 CONSOLE_WATCHERCB_MSGID;生产映射与审计表咬合锁——verify 逐条比
// 对,不沿用未验证常量(表错了测试红)。

describe('WATCHER_PROTOCOL_AUDIT_VERSION(版本钉住)', () => {
  it('目标版本非空且指向 kbengine 仓', () => {
    expect(WATCHER_PROTOCOL_AUDIT_VERSION.commit.length).toBeGreaterThanOrEqual(7);
    expect(WATCHER_PROTOCOL_AUDIT_VERSION.repoUrl).toContain('kbengine');
    expect(WATCHER_PROTOCOL_AUDIT_VERSION.xmlSource).toContain('messages_fixed_defaults.xml');
  });
});

describe('WATCHER_MESSAGE_PROTOCOL_AUDIT(请求号逐条引据)', () => {
  it('八条全覆盖生产映射:键集相等', () => {
    expect([...new Set(WATCHER_MESSAGE_PROTOCOL_AUDIT.map(entry => entry.componentType))].sort())
      .toEqual(Object.keys(WATCHER_QUERY_MSG_IDS).map(Number).sort());
  });

  it('每条 componentName 与 COMPONENT_NAMES 枚举位一致(不自造名词)', () => {
    for (const entry of WATCHER_MESSAGE_PROTOCOL_AUDIT) {
      expect(entry.componentName).toBe(COMPONENT_NAMES[entry.componentType]);
    }
  });

  it('每条引据指名 xml 文件与 queryWatcher 段', () => {
    for (const entry of WATCHER_MESSAGE_PROTOCOL_AUDIT) {
      expect(entry.requestSource).toContain('messages_fixed_defaults.xml');
      expect(entry.requestSource).toContain('::queryWatcher');
      expect(entry.requestSource).toContain(`${entry.requestMsgId}`);
    }
  });

  it('组件类型互不重复', () => {
    const types = WATCHER_MESSAGE_PROTOCOL_AUDIT.map(entry => entry.componentType);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('WATCHER_CB_PROTOCOL_AUDIT(回包号引据)', () => {
  it('65502 与生产常量一致,引据指名 console_helper.h', () => {
    expect(WATCHER_CB_PROTOCOL_AUDIT.msgId).toBe(CONSOLE_WATCHER_CB_MSG_ID);
    expect(WATCHER_CB_PROTOCOL_AUDIT.source).toContain('console_helper.h');
    expect(WATCHER_CB_PROTOCOL_AUDIT.source).toContain('CONSOLE_WATCHERCB_MSGID');
  });
});

describe('verifyWatcherProtocolAgainstAudit(生产映射咬合锁)', () => {
  it('生产映射逐条与审计表一致 → ok', () => {
    const verdict = verifyWatcherProtocolAgainstAudit(WATCHER_QUERY_MSG_IDS);
    expect(verdict.ok).toBe(true);
    expect(verdict.mismatches).toEqual([]);
  });

  it('错号映射 → mismatch 点名组件与两号(不沿用未验证常量)', () => {
    const verdict = verifyWatcherProtocolAgainstAudit({ ...WATCHER_QUERY_MSG_IDS, 5: 41001 });
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches.join('\n')).toContain('cellapp');
    expect(verdict.mismatches.join('\n')).toContain('41002');
    expect(verdict.mismatches.join('\n')).toContain('41001');
  });

  it('缺键/多键都算不咬合', () => {
    const missing = { ...WATCHER_QUERY_MSG_IDS } as Record<number, number>;
    delete missing[1];
    expect(verifyWatcherProtocolAgainstAudit(missing).ok).toBe(false);
    expect(verifyWatcherProtocolAgainstAudit({ ...WATCHER_QUERY_MSG_IDS, 99: 41009 }).ok).toBe(false);
  });
});
