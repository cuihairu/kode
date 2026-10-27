import { expect, it, vi } from 'vitest';
import * as parser from '../src/pythonParser';
import { computeReceiverNoneFindings } from '../src/receiverNoneDiagnostics';

vi.mock('../src/pythonParser', { spy: true });

it('没有 receiver 使用点时不运行完整 Python parser', () => {
  vi.mocked(parser.parsePythonFile).mockClear();
  expect(computeReceiverNoneFindings('class A:\n    def f(self):\n        return 42\n', '/a.py')).toEqual([]);
  expect(parser.parsePythonFile).not.toHaveBeenCalled();
  expect(computeReceiverNoneFindings('class A:\n    def f(self):\n        self.cell.tick()\n', '/a.py')).toHaveLength(1);
  expect(parser.parsePythonFile).toHaveBeenCalledTimes(1);
});
