"""Contract tests for the official engine adapter; KBEngine is simulated."""
import hashlib
import importlib.util
from pathlib import Path
import shutil
import sys
sys.dont_write_bytecode = True
import tempfile
import threading
import types
import unittest

REPO = Path(__file__).resolve().parents[2]


class OfficialReloadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'scripts'
        shutil.copytree(str(REPO / 'templates/demo-game/scripts'), str(self.root))
        self.engine = types.ModuleType('KBEngine')
        sys.modules['KBEngine'] = self.engine
        sys.path[:0] = [str(self.root / 'common'), str(self.root / 'base')]
        import KodeHotReload
        self.bridge = KodeHotReload
        self.server = KodeHotReload.ReloadServer.__new__(KodeHotReload.ReloadServer)
        self.server.root, self.server.role = self.root, 'base'
        self.server.revision, self.server.reload_callbacks = 0, 0
        self.server.lock, self.server.last = threading.Lock(), []
        setattr(self.engine, KodeHotReload._STATE, self.server)
        self.path = self.root / 'base/NativeExample.py'
        self.path.write_text('class NativeExample:\n    def value(self):\n        return 1\n')
        self.spec = importlib.util.spec_from_file_location('NativeExample', str(self.path))
        self.module = importlib.util.module_from_spec(self.spec)
        sys.modules['NativeExample'] = self.module
        self.spec.loader.exec_module(self.module)
        self.live = self.module.NativeExample()
        self.calls = []

        def native_reload(full):
            self.calls.append(full)
            self.spec.loader.exec_module(self.module)
            # Simulate engine rebinding an existing entity to its reloaded script class.
            self.live.__class__ = self.module.NativeExample
            self.bridge.start('base', True)
        self.engine.reloadScript = native_reload

    def tearDown(self):
        del sys.path[:2]
        for name in ['NativeExample', 'KodeHotReload', 'xreload', 'KBEngine']:
            sys.modules.pop(name, None)
        self.tmp.cleanup()

    def payload(self):
        self.path.write_text('class NativeExample:\n    def value(self):\n        return 2\n')
        return {'files': [str(self.path)], 'targetId': 'native',
                'sender_digests': {str(self.path): hashlib.sha256(self.path.read_bytes()).hexdigest()}}

    def test_official_calls_engine_and_requires_callback(self):
        self.bridge.xreload = lambda *_a, **_k: self.fail('official channel must not use xreload')
        receipt = self.bridge.official_reload(self.payload(), False)[0]
        self.assertEqual(self.calls, [False])
        self.assertEqual(receipt['status'], 'applied', receipt)
        self.assertEqual(receipt['method'], 'kbengine-official')
        self.assertEqual(self.live.value(), 2)

    def test_native_return_without_observer_is_unconfirmed_failure(self):
        self.engine.reloadScript = lambda full: None
        receipt = self.bridge.official_reload(self.payload())[0]
        self.assertEqual(receipt['status'], 'failed')
        self.assertIn('onInit', receipt['reason'])

    def test_wrong_process_and_digest_are_rejected_before_engine(self):
        payload = self.payload()
        payload['sender_digests'][str(self.path)] = 'bad'
        self.assertEqual(self.bridge.official_reload(payload)[0]['status'], 'failed')
        self.assertEqual(self.calls, [])
        payload = {'files': [str(self.root / 'cell/Avatar.py')]}
        self.assertEqual(self.bridge.official_reload(payload)[0]['status'], 'failed')
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
