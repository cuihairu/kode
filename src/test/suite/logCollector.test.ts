import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type LogCollectorModule = typeof import('../../logCollector');

describe('KBEngineLogCollector', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineLogCollector: LogCollectorModule['KBEngineLogCollector'];
  const noop = (): undefined => undefined;

  before(() => {
    const outputChannel = {
      appendLine: noop,
      dispose: noop
    };

    const { loadedModule, restore } = loadModuleWithMocks<LogCollectorModule>(
      __filename,
      '../../logCollector',
      {
        vscode: createVscodeStub({
          window: {
            createOutputChannel: () => outputChannel
          },
          EventEmitter: class FakeEventEmitter<T> {
            event = () => undefined;
            fire(value?: T): void {
              void value;
            }
            dispose = noop;
          }
        }),
        net: { Socket: class FakeSocket {} }
      },
      true
    );

    restoreModuleMocks = restore;
    KBEngineLogCollector = loadedModule.KBEngineLogCollector;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  it('includes the protocol warning in disconnected and connected summaries', () => {
    const collector = new KBEngineLogCollector(
      {
        host: '127.0.0.1',
        port: 20022,
        autoReconnect: true,
        reconnectInterval: 5000,
        maxBufferSize: 1000
      },
      {} as never
    );

    assert.ok(collector.getUnavailableReason().includes('实验性实现'));
    assert.ok(collector.getStatusSummary().includes('实验性'));
  });
});
