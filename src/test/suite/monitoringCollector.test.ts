import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type MonitoringCollectorModule = typeof import('../../monitoringCollector');

describe('MonitoringCollector', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let MonitoringCollector: MonitoringCollectorModule['MonitoringCollector'];
  const noop = (): undefined => undefined;

  before(() => {
    const component = {
      uid: 1000,
      username: 'tester',
      componentType: 6,
      componentID: BigInt(1),
      componentIDEx: BigInt(1),
      globalOrderID: 0,
      groupOrderID: 1,
      genuuidSections: 0,
      intaddr: '127.0.0.1',
      intport: 40001,
      extaddr: '127.0.0.1',
      extport: 0,
      extaddrEx: '',
      pid: 12345,
      cpu: 5,
      mem: 128,
      usedmem: 0,
      state: 0,
      machineID: 1,
      extradata: BigInt(8),
      extradata1: BigInt(3),
      extradata2: BigInt(0),
      extradata3: BigInt(0),
      backaddr: 0,
      backport: 0,
      componentName: 'baseapp',
      fullName: 'baseapp1'
    };

    const fakeProtocol = {
      discoverLocalComponents: async () => [component],
      queryWatcherPath: async () => []
    };

    const { loadedModule, restore } = loadModuleWithMocks<MonitoringCollectorModule>(
      __filename,
      '../../monitoringCollector',
      {
        vscode: createVscodeStub({
          EventEmitter: class FakeEventEmitter<T> {
            event = () => undefined;
            fire(value?: T): void {
              void value;
            }
            dispose = noop;
          }
        }),
        './kbengineProtocol': fakeProtocol
      },
      true
    );

    restoreModuleMocks = restore;
    MonitoringCollector = loadedModule.MonitoringCollector;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  it('surfaces partial-data status when watcher responses are missing', async () => {
    const collector = new MonitoringCollector({} as never);

    await collector.refreshNow();

    assert.ok(collector.getStatusSummary().includes('watcher 无响应'));
    assert.ok(collector.getStatusSummary().includes('machine 返回的基础状态'));
    assert.strictEqual(collector.getAllMetrics()[0]?.statusLevel, 'warning');
  });
});
