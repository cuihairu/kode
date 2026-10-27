import { expect, it, vi } from 'vitest';
import { collectProjectPythonFilesAsync, resetPythonReturnAnnotationCache, resolveLocalVariableReturnType } from '../src/pythonReturnTypeInference';

const { readdir, readFile } = vi.hoisted(() => ({ readdir: vi.fn(), readFile: vi.fn() }));
vi.mock('fs', () => ({ promises: { readdir, readFile } }));

it('慢目录发现期间事件循环可推进，取消后不进入下一目录', async () => {
  readdir.mockReset();
  let release!: (entries: unknown[]) => void;
  readdir.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const token = { isCancellationRequested: false };
  const pending = collectProjectPythonFilesAsync('/project', 20000, token);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(readdir).toHaveBeenCalledTimes(1);
  token.isCancellationRequested = true;
  release([{ name: 'nested', isDirectory: () => true, isFile: () => false }]);
  expect(await pending).toEqual([]);
  expect(readdir).toHaveBeenCalledTimes(1);
});

it('实际返回类型查询将取消传递到目录发现，且取消后不读源码', async () => {
  readdir.mockReset();
  readFile.mockReset();
  resetPythonReturnAnnotationCache();
  let release!: (entries: unknown[]) => void;
  readdir.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const token = { isCancellationRequested: false };
  const pending = resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', '/project', token);
  await Promise.resolve();
  token.isCancellationRequested = true;
  release([{ name: 'source.py', isDirectory: () => false, isFile: () => true }]);
  expect(await pending).toBeNull();
  expect(readFile).not.toHaveBeenCalled();
});

it('同根并发请求共享构建，一个请求取消不影响另一个', async () => {
  readdir.mockReset();
  readFile.mockReset();
  resetPythonReturnAnnotationCache();
  let release!: (entries: unknown[]) => void;
  readdir.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  readFile.mockResolvedValue('def get_data() -> JSONDATA:\n    pass\n');
  const token = { isCancellationRequested: false };
  const first = resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', '/project', token);
  const second = resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', '/project');
  await Promise.resolve();
  expect(readdir).toHaveBeenCalledTimes(1);
  token.isCancellationRequested = true;
  release([{ name: 'source.py', isDirectory: () => false, isFile: () => true }]);
  expect(await first).toBeNull();
  expect(await second).toMatchObject({ annotation: 'JSONDATA' });
  expect(readFile).toHaveBeenCalledTimes(1);
});

it('构建失败后下一次请求重新构建', async () => {
  readdir.mockReset();
  readFile.mockReset();
  resetPythonReturnAnnotationCache();
  readdir.mockResolvedValueOnce(null).mockResolvedValueOnce([
    { name: 'source.py', isDirectory: () => false, isFile: () => true }
  ]);
  readFile.mockResolvedValue('def get_data() -> JSONDATA:\n    pass\n');
  const query = () => resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', '/project');
  await expect(query()).rejects.toThrow();
  await expect(query()).resolves.toMatchObject({ annotation: 'JSONDATA' });
  expect(readdir).toHaveBeenCalledTimes(2);
});

it('源码读取并发有上限，单文件失败不阻断其他结果', async () => {
  readdir.mockReset();
  readFile.mockReset();
  resetPythonReturnAnnotationCache();
  readdir.mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => ({
    name: `${i}.py`, isDirectory: () => false, isFile: () => true
  })));
  let active = 0;
  let peak = 0;
  readFile.mockImplementation(async (file: string) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    if (file.endsWith('/0.py')) throw new Error('unreadable');
    return 'def get_data() -> JSONDATA:\n    pass\n';
  });
  expect(await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', '/project'))
    .toMatchObject({ annotation: 'JSONDATA' });
  expect(readFile).toHaveBeenCalledTimes(20);
  expect(peak).toBeLessThanOrEqual(8);
  expect(peak).toBeGreaterThan(1);
});

it('排除无关目录并对 Python 文件排序', async () => {
  readdir.mockReset();
  const file = (name: string) => ({ name, isDirectory: () => false, isFile: () => true });
  const dir = (name: string) => ({ name, isDirectory: () => true, isFile: () => false });
  readdir.mockResolvedValueOnce([file('z.py'), dir('venv'), dir('src'), file('ignored.txt')]);
  readdir.mockResolvedValueOnce([file('a.py')]);
  expect(await collectProjectPythonFilesAsync('/project')).toEqual(['/project/src/a.py', '/project/z.py']);
  expect(readdir).toHaveBeenCalledTimes(2);
});
