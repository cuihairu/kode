import { describe, expect, it } from 'vitest';
import {
  classifyHotReloadErrorReason,
  formatHotReloadErrorReason,
  HOT_RELOAD_ERROR_REASON_LABELS,
  type HotReloadErrorReason
} from '../src/backend/hotReloadErrorReason';

// HR-STATE-010 错误原因七类可操作分类:输入=各面真实产出信号串,输出=七类
// 定性+标签+动作建议;未知如实 unknown 不猜。语料=逐字来自生产源的信号串
// (改源串须同步本语料)。格式面=已知加 `[标签]` 前缀(建议未内嵌才叠),
// 未知原样透传不污染用户可见文本。

const ALL_REASONS: readonly HotReloadErrorReason[] = [
  'config-error',
  'module-conflict',
  'syntax-error',
  'target-unreachable',
  'apply-failed',
  'receipt-untrusted',
  'restart-required',
  'unknown'
];

describe('HR-STATE-010 七类定义', () => {
  it('恰好 7 类 + unknown,标签全在', () => {
    expect(ALL_REASONS).toHaveLength(8);
    for (const reason of ALL_REASONS) {
      expect(HOT_RELOAD_ERROR_REASON_LABELS[reason].length).toBeGreaterThan(0);
    }
    // 未知标签如实「其他」,不冒充具体原因
    expect(HOT_RELOAD_ERROR_REASON_LABELS.unknown).toBe('其他');
  });
});

describe('HR-STATE-010 七类真实信号分类', () => {
  // 语料=逐字来自生产源的真实信号串(面名在注释;改面须同步)
  const cases: readonly [string, HotReloadErrorReason, string][] = [
    // 配置错误:模块身份 no-root / out-of-root / not-python / override 非法
    ['未配置脚本资源根(kbengine.hotReload.tempEdit.scriptRoot)', 'config-error', '未配置'],
    ['文件不在任何脚本资源根内: /a.py ∉ [/ws]', 'config-error', '不在任何脚本资源根内'],
    ['fileUri 为空,拒绝解析', 'config-error', 'fileUri 为空'],
    ['user override 非法(空/含空白/点段为空): x', 'config-error', 'user override 非法'],
    // 模块冲突:多根歧义(HR-MOD-006 不猜)
    [
      '文件命中多个脚本资源根,未唯一确定前拒绝解析(HR-MOD-006 不猜): /a.py ∈ [/ws, /ws2]',
      'module-conflict',
      '多个脚本资源根'
    ],
    // 语法错误:语法闸拦下 / 配置 XML 良构失败
    ['语法检查未通过', 'syntax-error', '语法检查未通过'],
    ['x.def: XML 良构失败(boom)', 'syntax-error', '良构失败'],
    // 目标不可达:transport 五分类(RUST-419 输出,已含动作建议)
    [
      '端点不可达:检查地址/端口与目标服务是否在监听(原始:ECONNREFUSED)',
      'target-unreachable',
      '端点不可达'
    ],
    ['证书校验失败:端点证书不受信任/已过期/与地址不匹配,检查端点证书或受信 CA 配置(原始:EPROTO)', 'target-unreachable', '证书校验失败'],
    ['目标连接中断:疑似 target 重启或中途断开,可用热更失败重试命令重发(原始:ECONNRESET)', 'target-unreachable', '目标连接中断'],
    ['传输失败:见原始原因(原始:fetch failed)', 'target-unreachable', '传输失败'],
    ['HTTP 发送失败:端点不可达:检查地址/端口(原始:ECONNREFUSED)', 'target-unreachable', 'HTTP 发送失败'],
    // 应用失败:非 2xx 送达判定 / 服务端拒绝
    ['HTTP 状态 500:非 2xx 不算送达', 'apply-failed', 'HTTP 状态 500'],
    // 回执不可信:channelSend 落账 / applied 核验不升格
    ['applied 回执不可信(digest 缺失或与所发内容不符):保持未确认', 'receipt-untrusted', '回执不可信'],
    ['applied 回执不可信(无内容读取通道,digest 无基准):保持未确认', 'receipt-untrusted', '无内容读取通道'],
    ['回执状态非 applied(得到 "failed"):不升格', 'receipt-untrusted', '不升格'],
    ['回执 digest 与所发内容不符:可疑回执不升格', 'receipt-untrusted', '可疑回执'],
    ['发送时点内容基准缺失,digest 无基准', 'receipt-untrusted', '基准缺失'],
    // 需重启:def 结构变更
    ['需重启:def 结构变更,不作为普通 Python reload 自动发送', 'restart-required', '需重启'],
    ['结构性 def 变更,普通 reload 被拦,需重启进程后再应用', 'restart-required', '结构性 def 变更']
  ];

  it('每条真实信号 → 对应七类(不改面不误判)', () => {
    for (const [raw, expected, anchor] of cases) {
      const info = classifyHotReloadErrorReason(raw);
      expect(info.category, `${raw} 应归 ${expected} (锚:${anchor})`).toBe(expected);
    }
  });
});

describe('HR-STATE-010 未知如实不猜', () => {
  it('裸 HTTP 500(无上下文)→ unknown,原样透传', () => {
    expect(classifyHotReloadErrorReason('HTTP 500').category).toBe('unknown');
    expect(formatHotReloadErrorReason('HTTP 500')).toBe('HTTP 500');
  });

  it('任意不可辨文本 → unknown,不加标签不改文', () => {
    for (const raw of ['boom', 'random failure', '', 'something happened']) {
      const info = classifyHotReloadErrorReason(raw);
      expect(info.category).toBe('unknown');
      expect(formatHotReloadErrorReason(raw)).toBe(raw);
    }
  });
});

describe('HR-STATE-010 匹配次序(具体先于泛化)', () => {
  it('回执不可信不误入目标不可达(两者都含「不可达」邻词但信号不同)', () => {
    // 回执串含「不可信」,不匹配 target-unreachable 的「不可达」——归回执
    expect(classifyHotReloadErrorReason('applied 回执不可信(digest 缺失或与所发内容不符):保持未确认').category).toBe(
      'receipt-untrusted'
    );
  });

  it('多根歧义先于配置(命中多个脚本资源根 ≠ 未配置)', () => {
    expect(classifyHotReloadErrorReason('文件命中多个脚本资源根,未唯一确定前拒绝解析: /a.py ∈ [/ws, /ws2]').category).toBe(
      'module-conflict'
    );
  });

  it('需重启先于配置/unknown(含「需重启」不误入)', () => {
    expect(classifyHotReloadErrorReason('需重启:def 解析失败(保守按结构性处理)').category).toBe('restart-required');
  });

  it('HTTP 状态(服务端拒绝)先于传输(请求已达非未达)', () => {
    expect(classifyHotReloadErrorReason('HTTP 状态 500:非 2xx 不算送达').category).toBe('apply-failed');
  });
});

describe('HR-STATE-010 格式面', () => {
  it('已知类别加 [标签] 前缀;未内嵌动作的消息叠 (建议:...)', () => {
    const config = formatHotReloadErrorReason('未配置脚本资源根(kbengine.hotReload.tempEdit.scriptRoot)');
    expect(config).toContain('[配置错误]');
    expect(config).toContain('未配置脚本资源根');
    expect(config).toContain('建议:配置脚本资源根');
    // 原文保留(定性不吞原文)
    expect(config).toContain('kbengine.hotReload.tempEdit.scriptRoot');
  });

  it('transport 类消息已内嵌动作,不叠建议只加标签', () => {
    const raw = '端点不可达:检查地址/端口与目标服务是否在监听(原始:ECONNREFUSED)';
    const out = formatHotReloadErrorReason(raw);
    expect(out).toContain('[目标不可达]');
    expect(out).toContain('检查地址/端口');
    expect(out).not.toContain('建议:'); // 已内嵌,不叠
  });

  it('需重启消息已内嵌动作,不叠建议', () => {
    const out = formatHotReloadErrorReason('结构性 def 变更,普通 reload 被拦,需重启进程后再应用');
    expect(out).toContain('[需重启]');
    expect(out).not.toContain('建议:');
  });

  it('语法错误消息未内嵌动作,叠建议', () => {
    const out = formatHotReloadErrorReason('语法检查未通过');
    expect(out).toContain('[语法错误]');
    expect(out).toContain('建议:修正脚本语法错误');
  });
});
