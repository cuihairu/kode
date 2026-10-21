import { describe, expect, it } from 'vitest';
import { getWebviewConsoleScript, WEBVIEW_LOG_COMMAND } from '../src/webviewConsoleBridge';

type PostedMessage = Record<string, unknown>;

interface BrowserStubs {
  console: Record<'log' | 'warn' | 'error' | 'debug', ReturnType<typeof createRecordingFn>>;
  window: Record<string, unknown>;
  listeners: Record<string, Array<(event: unknown) => void>>;
  location: unknown;
  posted: PostedMessage[];
  fakeConsole: Record<'log' | 'warn' | 'error' | 'debug', RecordingFn | undefined>;
}

function createRecordingFn(): RecordingFn {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return calls.length;
  };
  const recording = fn as RecordingFn;
  recording.mock = { calls };
  return recording;
}

type RecordingFn = ((...args: unknown[]) => number) & { mock: { calls: unknown[][] } };

const runBridge = (options: { throttle?: boolean; failPostMessage?: boolean } = {}): BrowserStubs => {
  const posted: PostedMessage[] = [];
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const fakeConsoleRef: Record<'log' | 'warn' | 'error' | 'debug', RecordingFn | undefined> = {
    log: undefined,
    warn: undefined,
    error: undefined,
    debug: undefined
  } as Record<'log' | 'warn' | 'error' | 'debug', RecordingFn | undefined>;
  const fakeConsole = {
    log: createRecordingFn(),
    warn: createRecordingFn(),
    error: createRecordingFn(),
    debug: createRecordingFn()
  };
  const fakeWindow = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      (listeners[type] ??= []).push(listener);
    }
  };
  const context = {
    console: fakeConsole,
    window: fakeWindow,
    location: { href: 'vscode-webview://panel' },
    vscode: {
      postMessage: (message: PostedMessage) => {
        if (options.failPostMessage) throw new Error('host unavailable');
        posted.push(message);
      }
    },
    setTimeout,
    Date,
    Promise,
    Array,
    Object,
    String,
    Number,
    Error,
    JSON,
    RegExp
  };
  const handler = new Function('console', 'window', 'location', 'vscode', getWebviewConsoleScript(options));
  handler.call(context, fakeConsole, fakeWindow, context.location, context.vscode);
  fakeConsoleRef.log = fakeConsole.log;
  fakeConsoleRef.warn = fakeConsole.warn;
  fakeConsoleRef.error = fakeConsole.error;
  fakeConsoleRef.debug = fakeConsole.debug;
  return { console: fakeConsole, fakeConsole: fakeConsoleRef, window: fakeWindow, listeners, location: context.location, posted };
};

describe('webview console bridge', () => {

  it('wraps console methods with mapped levels, timestamps and source', () => {
    const browser = runBridge();
    browser.console.debug('debug value', 42);
    browser.console.log('info value');
    browser.console.warn('warning value');
    browser.console.error('error value', new Error('boom'));

    expect(browser.posted.map(message => message.command)).toEqual(Array(4).fill(WEBVIEW_LOG_COMMAND));
    expect(browser.posted.map(message => message.level)).toEqual(['debug', 'info', 'warning', 'error']);
    expect(browser.posted.every(message => typeof message.timestamp === 'number')).toBe(true);
    expect(new Set(browser.posted.map(message => message.origin))).toEqual(new Set(['vscode-webview://panel']));
    expect(browser.posted[0].text).toBe('debug value 42');
    expect(browser.posted[3].text).toContain('Error: boom');
    const originalWarn = browser.fakeConsole.warn;
    expect(originalWarn && originalWarn.mock ? originalWarn.mock.calls.length : 0).toBe(0);
    expect(browser.console.warn.mock?.calls ?? []).toHaveLength(0);

  });

  it('batches repeated calls when throttling is enabled', async () => {
    const browser = runBridge({ throttle: true });
    browser.console.log('first');
    browser.console.warn('second');
    expect(browser.posted).toHaveLength(0);

    await new Promise(resolve => setTimeout(resolve, 25));
    expect(browser.posted.map(message => message.text)).toEqual(['first', 'second']);
  });

  it('sends immediately for exceptions even when throttling is enabled', () => {
    const browser = runBridge({ throttle: true });
    const handlers = browser.listeners as Record<'error' | 'unhandledrejection', Array<(event: unknown) => void>>;
    handlers.error[0]({ message: 'bad expression', filename: 'page.js', lineno: 7 });
    handlers.unhandledrejection[0]({ reason: new Error('rejected') });

    expect(browser.posted.map(message => [message.level, String(message.text).split('\n')[0]])).toEqual([
      ['error', 'bad expression (page.js:7)'],
      ['error', 'Unhandled rejection: Error: rejected']
    ]);
  });

  it('stays silent and does not break the page when the host is unavailable', () => {
    const browser = runBridge({ failPostMessage: true });
    expect(() => browser.console.log('page continues')).not.toThrow();

    const originalWarn = browser.fakeConsole.warn;
    expect(originalWarn && originalWarn.mock ? originalWarn.mock.calls.length : 1).toBe(1);
    if (originalWarn?.mock?.calls) {
      expect(originalWarn.mock.calls).toHaveLength(1);
    }
  });
});

