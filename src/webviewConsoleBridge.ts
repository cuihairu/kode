export interface WebviewLogMessage {
  command: 'webviewLog';
  level: 'debug' | 'info' | 'warning' | 'error';
  timestamp: number;
  origin: string;
  text: string;
}

export const WEBVIEW_LOG_COMMAND = 'webviewLog';

const WEBVIEW_LOG_SCRIPT = String.raw`
(function () {
  var originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };
  var levels = { log: 'info', warn: 'warning', error: 'error', debug: 'debug' };
  var queue = [];
  var timer = null;
  var shouldThrottle = false;

  function serialize(value, seen) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return String(value);
    if (seen.indexOf(value) !== -1) return '[Circular]';
    try {
      var nextSeen = seen.concat([value]);
      if (Array.isArray(value)) {
        return '[' + value.map(function (item) { return serialize(item, nextSeen); }).join(', ') + ']';
      }
      return '{' + Object.keys(value).map(function (key) {
        return key + ': ' + serialize(value[key], nextSeen);
      }).join(', ') + '}';
    } catch (error) {
      return '[Unserializable]';
    }
  }

  function send(level, text, origin) {
    try {
      vscode.postMessage({
        command: 'webviewLog',
        level: level,
        timestamp: Date.now(),
        origin: origin || location.href,
        text: text
      });
    } catch (error) {
      originalConsole.warn(error);
    }
  }

  function flush() {
    timer = null;
    var batch = queue;
    queue = [];
    batch.forEach(function (entry) {
      send(entry.level, entry.text, entry.origin);
    });
  }

  function enqueue(level, args, origin) {
    var text = Array.prototype.map.call(args, function (item) {
      return serialize(item, []);
    }).join(' ');
    if (shouldThrottle) {
      queue.push({ level: level, origin: origin, text: text });
      if (!timer) timer = setTimeout(flush, 20);
      return;
    }
    queue.push({ level: level, origin: origin, text: text });
    flush();
  }

  function sendNow(level, args, origin) {
    var text = Array.prototype.map.call(args, function (item) {
      return serialize(item, []);
    }).join(' ');
    send(level, text, origin);
  }

  ['log', 'warn', 'error', 'debug'].forEach(function (method) {
    var wrapped = function () {
      enqueue(levels[method], arguments);
      originalConsole[method].apply(console, arguments);
    };
    try {
      console[method] = wrapped;
    } catch (error) {
      console.error(error);
    }
  });

  window.addEventListener('error', function (event) {
    var detail = event.error ? serialize(event.error, []) : event.message;
    sendNow('error', [detail + ' (' + event.filename + ':' + event.lineno + ')'], event.filename);
  });

  window.addEventListener('unhandledrejection', function (event) {
    sendNow('error', ['Unhandled rejection: ' + serialize(event.reason, [])]);
  });
})();
`;

export function getWebviewConsoleScript(options: { throttle?: boolean } = {}): string {
  return WEBVIEW_LOG_SCRIPT.replace(
    'var shouldThrottle = false;',
    `var shouldThrottle = ${options.throttle === true};`
  );
}
