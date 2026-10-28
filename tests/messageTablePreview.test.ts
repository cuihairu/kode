import { describe, expect, it, vi } from 'vitest';
import { showEntityMessageTablePreview } from '../src/messageTablePreview';

// IDE-SDK-001 增加单实体 messageTable 预览命令:选实体(QuickPick)→
// 现有计算结果(buildMessageTable→markdown)可查看;缺声明(构建返回
// null,entities.xml 未登记/entity_defs 缺 def)时明确提示,不展示空
// 预览不猜;未发现任何实体如实提示;取消选择静默退出。

const deps = (overrides: Partial<Parameters<typeof showEntityMessageTablePreview>[0]> = {}) => ({
  listEntityNames: vi.fn(() => ['Avatar', 'Monster']),
  buildTableMarkdown: vi.fn(() => '# messageTable: Avatar'),
  pick: vi.fn(async () => 'Avatar'),
  show: vi.fn(async () => undefined),
  notifyWarning: vi.fn(),
  notifyInformation: vi.fn(),
  ...overrides
});

describe('showEntityMessageTablePreview(单实体 messageTable 预览)', () => {
  it('选实体后展示现有计算结果(markdown)', async () => {
    const d = deps();
    await showEntityMessageTablePreview(d);

    expect(d.pick).toHaveBeenCalledWith(['Avatar', 'Monster']);
    expect(d.buildTableMarkdown).toHaveBeenCalledWith('Avatar');
    expect(d.show).toHaveBeenCalledWith('# messageTable: Avatar');
    expect(d.notifyWarning).not.toHaveBeenCalled();
  });

  it('缺声明(构建 null)→ 明确提示,不展示空预览', async () => {
    const d = deps({ buildTableMarkdown: vi.fn(() => null) });
    await showEntityMessageTablePreview(d);

    expect(d.notifyWarning).toHaveBeenCalledTimes(1);
    const message = d.notifyWarning.mock.calls[0]?.[0] as string;
    expect(message).toContain('Avatar');
    expect(message).toContain('def');
    expect(d.show).not.toHaveBeenCalled();
  });

  it('未发现任何实体 → 如实提示,不弹选择', async () => {
    const d = deps({ listEntityNames: vi.fn(() => []) });
    await showEntityMessageTablePreview(d);

    expect(d.pick).not.toHaveBeenCalled();
    expect(d.notifyWarning.mock.calls[0]?.[0]).toContain('实体');
  });

  it('取消选择 → 静默退出', async () => {
    const d = deps({ pick: vi.fn(async () => undefined) });
    await showEntityMessageTablePreview(d);

    expect(d.buildTableMarkdown).not.toHaveBeenCalled();
    expect(d.show).not.toHaveBeenCalled();
    expect(d.notifyWarning).not.toHaveBeenCalled();
  });

  it('实体清单排序稳定(字典序)', async () => {
    const d = deps({ listEntityNames: vi.fn(() => ['Monster', 'Avatar', 'Gate']) });
    await showEntityMessageTablePreview(d);
    expect(d.pick).toHaveBeenCalledWith(['Avatar', 'Gate', 'Monster']);
  });
});
