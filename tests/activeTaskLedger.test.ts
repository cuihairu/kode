import { describe, expect, it } from 'vitest';
import {
  getActiveOperationCounts,
  renderActiveTasksReport,
  resetLanguageServiceMetrics,
  startLanguageServiceOperation
} from '../src/languageServiceMetrics';

// IDE-MET-008:导出待处理与取消后残留任务数。验收口径:请求取消前后能
// 比较活动任务(账面在册数),不用空返回值推断工作已停止——取消后的
// 残留必须从账上读出来,而不是从 provider 返回 null 猜。台账挂在
// startLanguageServiceOperation 生命周期上(起=入册,end=出册,含
// cancelled 终态);诊断调度器的 queued/inFlight(DIA-006 诚实面)并列。

describe('活动任务台账(IDE-MET-008)', () => {
  it('纯渲染:操作族在册数+调度器排队/在途并列,标题声明口径', () => {
    const report = renderActiveTasksReport({
      operationCounts: { hover: 1, definition: 2, completion: 0 },
      scheduler: { queued: 3, inFlight: 1 }
    });
    expect(report).toContain('active tasks');
    expect(report).toContain('hover: 1');
    expect(report).toContain('definition: 2');
    expect(report, '零在册族不隐藏——0 也是账面').toContain('completion: 0');
    expect(report).toContain('queued=3 inFlight=1');
    expect(report).toContain('total: 3');
    expect(report).toContain('do not infer stopped work from empty return values');
  });

  it('取消前后比较活动任务:hover 取消后在册归零,账面而非返回值说话', () => {
    resetLanguageServiceMetrics();
    const token = { isCancellationRequested: false };
    const operation = startLanguageServiceOperation('hover', { fileKind: 'python' });
    expect(getActiveOperationCounts().hover).toBe(1);

    // 请求取消传播:token 置取消,操作以 cancelled 终态收口
    token.isCancellationRequested = true;
    const returnValue = null;
    operation.end(token.isCancellationRequested ? 'cancelled' : 'ok');
    expect(returnValue).toBeNull();

    const after = getActiveOperationCounts();
    expect(after.hover ?? 0, '取消后残留必须从账上读:应为 0(族缺席=零在册)').toBe(0);
    // 重复 end 不得二次出册(账面不因防御性重复调用变负)
    operation.end('cancelled');
    expect(getActiveOperationCounts().hover ?? 0).toBe(0);
    resetLanguageServiceMetrics();
  });

  it('多族并行在册:各族独立计数,end 只出册本族', () => {
    resetLanguageServiceMetrics();
    const hover = startLanguageServiceOperation('hover', {});
    const definition = startLanguageServiceOperation('definition', {});
    const anotherHover = startLanguageServiceOperation('hover', {});
    expect(getActiveOperationCounts()).toEqual({ hover: 2, definition: 1 });
    hover.end('ok');
    expect(getActiveOperationCounts()).toEqual({ hover: 1, definition: 1 });
    anotherHover.end('miss');
    definition.end('ok');
    expect(getActiveOperationCounts()).toEqual({});
    resetLanguageServiceMetrics();
  });
});
