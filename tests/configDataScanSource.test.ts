/**
 * 配置数据诊断全扫取文策略(2026-11-24 Navigation 刷屏修复):已开档读缓冲
 * (所见即所诊),未开档直读盘并剥 BOM。契约=全扫不得产生 openTextDocument
 * 事件面(扫描自己给自己供弹的根因),故本策略层零 vscode open 依赖——
 * uri 匹配只对已开文档列表做 toString 比对,盘读走共享原文缓存。
 */
import { describe, expect, it, vi } from 'vitest';
import { readConfigScanSourceText } from '../src/backend/configDataScanSource';
import { readFileUtf8Recorded } from '../src/backend/fileReadMetrics';

vi.mock('../src/backend/fileReadMetrics', () => ({
  readFileUtf8Recorded: vi.fn()
}));

const mockedRead = vi.mocked(readFileUtf8Recorded);

const doc = (uriString: string, text: string) => ({
  uri: { toString: () => uriString },
  getText: () => text
});

const uri = (fsPath: string, uriString?: string) => ({
  fsPath,
  toString: () => uriString ?? `file://${fsPath}`
});

describe('readConfigScanSourceText 取文策略', () => {
  it('已开档命中缓冲:返回 getText 内容,不触盘读', async () => {
    const opened = doc('file:///w/scripts/Avatar.py', 'class Avatar:\n    pass\n');
    const text = await readConfigScanSourceText(uri('/w/scripts/Avatar.py'), [opened]);
    expect(text).toBe('class Avatar:\n    pass\n');
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it('未开档直读盘:reader 收 fsPath,BOM 剥离(与文档面 getText 口径一致)', async () => {
    mockedRead.mockResolvedValue('\uFEFFimport sys\n');
    const text = await readConfigScanSourceText(uri('/w/scripts/Misc.py', 'file:///w/scripts/Misc.py'), []);
    expect(mockedRead).toHaveBeenCalledWith('/w/scripts/Misc.py');
    expect(text).toBe('import sys\n');
  });

  it('uri 按 toString 全等匹配:路径不同即未开,落盘读', async () => {
    mockedRead.mockResolvedValue('x = 1\n');
    const other = doc('file:///w/scripts/Other.py', 'wrong');
    const text = await readConfigScanSourceText(
      uri('/w/scripts/Avatar.py', 'file:///w/scripts/Avatar.py'),
      [other]
    );
    expect(text).toBe('x = 1\n');
  });

  it('盘读失败原样上抛(调用面 catch 跳过该文件,不猜)', async () => {
    mockedRead.mockRejectedValue(new Error('ENOENT'));
    await expect(
      readConfigScanSourceText(uri('/gone/X.py', 'file:///gone/X.py'), [])
    ).rejects.toThrow('ENOENT');
  });
});
