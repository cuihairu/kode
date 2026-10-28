import { describe, expect, it, vi } from 'vitest';
import { exportEntityMessageTable } from '../src/messageTableExport';

// IDE-SDK-002 提供消息表 JSON 导出:输出保留方法段、utype、alias 配置
// 与问题清单(renderMessageTableJson 现有面,由构建端保证);保存对话
// 框取消不创建文件(writeFile 零调用);缺声明/空清单如实提示;写失败
// 如实呈现。

const JSON_BODY = '{"sections":[],"utypes":[],"alias":null,"issues":[]}';

const deps = (overrides: Record<string, unknown> = {}) => ({
  listEntityNames: vi.fn(() => ['Avatar']),
  buildTableJson: vi.fn(() => JSON_BODY),
  pick: vi.fn(async () => 'Avatar'),
  chooseSavePath: vi.fn(async () => '/ws/Avatar.messagetable.json'),
  writeFile: vi.fn(async () => undefined),
  notifyWarning: vi.fn(),
  notifyInformation: vi.fn(),
  ...overrides
});

describe('exportEntityMessageTable(消息表 JSON 导出)', () => {
  it('全流程:选中实体→选保存路径→写文件→成功提示带路径', async () => {
    const d = deps();
    await exportEntityMessageTable(d);

    expect(d.chooseSavePath).toHaveBeenCalledWith('Avatar.messagetable.json');
    expect(d.writeFile).toHaveBeenCalledWith('/ws/Avatar.messagetable.json', JSON_BODY);
    expect(d.notifyInformation.mock.calls[0]?.[0]).toContain('/ws/Avatar.messagetable.json');
  });

  it('保存对话框取消 → 不创建文件(writeFile 零调用),无成功提示', async () => {
    const d = deps({ chooseSavePath: vi.fn(async () => undefined) });
    await exportEntityMessageTable(d);

    expect(d.writeFile).not.toHaveBeenCalled();
    expect(d.notifyInformation).not.toHaveBeenCalled();
    expect(d.notifyWarning).not.toHaveBeenCalled();
  });

  it('缺声明(build null)→ 明确提示,不弹保存对话框', async () => {
    const d = deps({ buildTableJson: vi.fn(() => null) });
    await exportEntityMessageTable(d);

    expect(d.notifyWarning.mock.calls[0]?.[0]).toContain('Avatar');
    expect(d.chooseSavePath).not.toHaveBeenCalled();
    expect(d.writeFile).not.toHaveBeenCalled();
  });

  it('未发现实体 → 如实提示,不弹选择', async () => {
    const d = deps({ listEntityNames: vi.fn(() => []) });
    await exportEntityMessageTable(d);
    expect(d.pick).not.toHaveBeenCalled();
    expect(d.notifyWarning.mock.calls[0]?.[0]).toContain('实体');
  });

  it('实体选择取消 → 静默退出零后续', async () => {
    const d = deps({ pick: vi.fn(async () => undefined) });
    await exportEntityMessageTable(d);
    expect(d.chooseSavePath).not.toHaveBeenCalled();
    expect(d.writeFile).not.toHaveBeenCalled();
  });

  it('写文件失败 → 如实警告带原因', async () => {
    const d = deps({ writeFile: vi.fn(async () => { throw new Error('EACCES'); }) });
    await exportEntityMessageTable(d);
    expect(d.notifyWarning.mock.calls[0]?.[0]).toContain('EACCES');
    expect(d.notifyInformation).not.toHaveBeenCalled();
  });
});
