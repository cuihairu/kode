"""Real HTTP + descriptor dispatch tests; KBEngine is simulated, not a live game engine."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
sys.dont_write_bytecode = True
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = REPO / 'templates/demo-game/scripts'


def worker(root, role, peer):
    callbacks = selectors.DefaultSelector()
    engine = types.ModuleType('KBEngine')
    def register(fd, cb):
        def observe(number):
            assert threading.get_ident() == main
            cb(number)
            print('RUNTIME_VALUE=' + str(saved_method()), flush=True)
            print('FUNCTION_VALUE=' + str(saved_function()), flush=True)
        callbacks.register(fd, selectors.EVENT_READ, observe)
    engine.registerReadFileDescriptor = register
    engine.deregisterReadFileDescriptor = lambda fd: callbacks.unregister(fd)
    sys.modules['KBEngine'] = engine
    debug = types.ModuleType('KBEDebug')
    for name in ('DEBUG_MSG', 'INFO_MSG', 'ERROR_MSG', 'WARNING_MSG'):
        setattr(debug, name, lambda *_: None)
    sys.modules['KBEDebug'] = debug
    sys.path[:0] = [str(Path(root) / role), str(Path(root) / 'common')]
    import DemoValue
    import DemoShared
    existing = DemoValue.Example()
    saved_method = existing.value
    saved_function = DemoValue.value
    import kbemain
    import KodeHotReload
    main = threading.get_ident()

    def reload_script(full):
        raise AssertionError('HTTP xreload must not call official reloadScript')

    engine.reloadScript = reload_script
    os.environ['KODE_HOT_RELOAD_BASE_PORT'] = '0'
    os.environ['KODE_HOT_RELOAD_CELL_PORT'] = '0'
    kbemain.onInit(False)
    server = getattr(engine, KodeHotReload._STATE)
    server.peer_port = int(peer)
    print('PORT=' + str(server.http.server_port), flush=True)
    while True:
        for key, _ in callbacks.select(timeout=1):
            key.data(key.fd)


class DemoHotReloadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'scripts'
        shutil.copytree(TEMPLATE, self.root)
        self.processes = []
        (self.root / "common/DemoShared.py").write_text(self.source(1))
        for role in ('base', 'cell', 'common'):
            (self.root / role / 'DemoValue.py').write_text(self.source(1))

    def tearDown(self):
        for process in self.processes:
            process.terminate()
            process.communicate(timeout=5)
        self.tmp.cleanup()

    def start(self, role='base', peer=1):
        process = subprocess.Popen([sys.executable, __file__, '--worker', str(self.root), role, str(peer)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        for _ in range(10):
            line = process.stdout.readline()
            if line.startswith('PORT='):
                return int(line.strip().split('=')[1])
            if not line:
                self.fail(process.stderr.read())
        self.fail('worker did not start')

    def call(self, port, payload=None, path='/hotfix'):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request('http://127.0.0.1:%s%s' % (port, path), data=data,
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.load(response)

    @staticmethod
    def source(value):
        return ('def value():\n    return %s\nclass Example:\n    def value(self):\n        return %s\n' % (value, value))

    def payload(self, role='base', value=2):
        path = self.root / role / 'DemoValue.py'
        path.write_text(self.source(value))
        return {'files': [str(path)], 'targetId': 'default',
                'sender_digests': {str(path): hashlib.sha256(path.read_bytes()).hexdigest()}}

    def test_http_xreload_updates_existing_instance_and_saved_function(self):
        port = self.start()
        payload = self.payload()
        result = self.call(port, payload)[0]
        self.assertEqual(result['status'], 'applied', result)
        self.assertEqual(result['digest'], payload['sender_digests'][payload['files'][0]])
        self.assertEqual(result['revision'], 1)
        self.assertEqual(result['targetId'], 'default')
        # Same-size quick save must bypass timestamp-based pyc caching.
        self.assertEqual(self.call(port, self.payload(value=3))[0]['revision'], 2)
        self.assertEqual(self.call(port, path='/status')['revision'], 2)
        lines = [self.processes[0].stdout.readline() for _ in range(6)]
        self.assertIn('RUNTIME_VALUE=2\n', lines)
        self.assertIn('RUNTIME_VALUE=3\n', lines)
        self.assertIn('FUNCTION_VALUE=2\n', lines)
        self.assertIn('FUNCTION_VALUE=3\n', lines)

    def test_digest_mismatch_does_not_execute(self):
        port = self.start()
        payload = self.payload()
        payload['sender_digests'][payload['files'][0]] = 'bad'
        self.assertEqual(self.call(port, payload)[0]['status'], 'failed')
        self.assertEqual(self.call(port, path='/status')['revision'], 0)

    def test_syntax_error_and_unloaded_module_fail(self):
        port = self.start()
        path = self.root / 'base/DemoValue.py'
        path.write_text('def broken(')
        self.assertEqual(self.call(port, {'files': [str(path)]})[0]['status'], 'failed')
        path = self.root / 'base/Unused.py'
        path.write_text('x = 1')
        result = self.call(port, {'files': [str(path)]})[0]
        self.assertEqual(result['status'], 'failed')
        self.assertIn('not loaded', result['reason'])

    def test_runtime_error_is_not_applied(self):
        port = self.start()
        payload = self.payload()
        path = Path(payload['files'][0])
        path.write_text('raise RuntimeError("failed module execution")\n')
        payload['sender_digests'][str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(self.call(port, payload)[0]['status'], 'failed')
        self.assertEqual(self.call(port, path='/status')['revision'], 0)
        self.assertEqual(self.call(port, self.payload(value=3))[0]['status'], 'applied')

    def test_gateway_routes_cell_and_requires_both_processes_for_common(self):
        cell = self.start('cell')
        base = self.start('base', cell)
        receipt = self.call(base, self.payload('cell'))[0]
        self.assertEqual(receipt['status'], 'applied', receipt)
        self.assertEqual(receipt['processes'], ['cell'])
        shared = self.root / 'common/DemoShared.py'
        shared.write_text(self.source(7))
        receipt = self.call(base, {'files': [str(shared)]})[0]
        self.assertEqual(receipt['status'], 'applied', receipt)
        self.assertEqual(receipt['processes'], ['base', 'cell'])
        # An unloaded common module must not be reported as applied.
        self.assertEqual(self.call(base, self.payload('common'))[0]['status'], 'failed')

    def test_missing_cell_and_outside_root_do_not_claim_applied(self):
        base = self.start('base', 1)
        self.assertEqual(self.call(base, self.payload('cell'))[0]['status'], 'failed')
        self.assertEqual(self.call(base, {'files': ['/tmp/outside.py']})[0]['status'], 'failed')
        self.assertEqual(self.call(base, {'files': [str(self.root / 'base/kbemain.py')]})[0]['status'], 'failed')

    def test_health_get_never_reloads(self):
        port = self.start()
        for _ in range(2):
            self.assertEqual(self.call(port)['revision'], 0)
        with self.assertRaises(urllib.error.HTTPError):
            self.call(port, {'files': []})


if __name__ == '__main__':
    if '--worker' in sys.argv:
        worker(*sys.argv[2:])
    else:
        unittest.main()
