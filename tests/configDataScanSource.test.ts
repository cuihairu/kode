/**
 * 配置数据诊断全扫取文策略(2026-11-24 Navigation 刷屏修复):已开档读缓冲
 * (所见即所诊),未开档直读盘并剥 BOM。契约=全扫不得产生 openTextDocument
 * 事件面(扫描自己给自己供弹的根因),故本策略层零 vscode open 依赖——
 * uri 匹配只对已开文档列表做 toString 比对,盘读走共享原文缓存。
 */
import * as fs from 'fs';
import * as path from 'path';
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

/**
 * 触发器分工契约(2026-11-24 用户裁定,源级守卫防回植):
 * 打开文件=per-file 诊断/预热面,不得触发 configData 全扫;
 * 全扫只属于「输入变了」:编辑/保存/外部增删改/激活/配置变更;
 * 全扫取文不得经 openTextDocument(会自制造 open 事件自供弹)。
 */
describe('configData 全扫触发器分工契约(源级)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/activate/diagnostics.ts'), 'utf8'
  );

  it('onDidOpenTextDocument 不再接 scheduleConfigDataScan', () => {
    expect(/onDidOpenTextDocument\([\s\S]{0,200}?queueChange/.test(source)).toBe(false);
  });

  it('编辑与保存将当前文件交给增量队列', () => {
    expect(source).toMatch(/onDidChangeTextDocument\([\s\S]{0,300}?queueChange\(event.document.uri/);
    expect(source).toMatch(/onDidSaveTextDocument\([\s\S]{0,200}?queueChange\(document.uri/);
  });

  it('外部增删改有 FS watcher 腿(不经编辑器路径也重算)', () => {
    expect(source).toMatch(/createFileSystemWatcher\(new vscode.RelativePattern\(root, '\*\*\/\*\.py'\)\)[\s\S]{0,400}?onDidDelete/);
  });

  it('全扫取文走 readConfigScanSourceText,文件内零 openTextDocument 调用', () => {
    expect(source).toMatch(/const text = await readConfigScanSourceText\(uri, vscode\.workspace\.textDocuments\)/);
    // 调用形状守卫(注释里提及历史不红):任何 .openTextDocument( 调用即红
    expect(/\.openTextDocument\(/.test(source)).toBe(false);
  });
});
