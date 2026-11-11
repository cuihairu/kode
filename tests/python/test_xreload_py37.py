"""Run with CPython 3.7.3 as well as newer Python; no external dependencies."""
import importlib
import importlib.util
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('kode_xreload', str(ROOT / 'templates/demo-game/scripts/common/xreload.py'))
XR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(XR)


class XReloadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / 'subject.py'
        self.modules = []

    def tearDown(self):
        for name in self.modules:
            sys.modules.pop(name, None)
        self.tmp.cleanup()

    def load(self, source):
        self.path.write_text(source, encoding='utf-8')
        name = 'kode_subject_' + str(id(self))
        spec = importlib.util.spec_from_file_location(name, str(self.path))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        self.modules.append(name)
        spec.loader.exec_module(mod)
        return mod

    def update(self, module, source):
        self.path.write_text(source, encoding='utf-8')
        self.assertIs(XR.xreload(module), module)

    def test_existing_instance_bound_method_and_function_identity(self):
        source = 'def f():\n    return 1\nclass C:\n    def f(self):\n        return 1\n'
        mod = self.load(source)
        obj, cls, function = mod.C(), mod.C, mod.f
        bound = obj.f
        self.update(mod, source.replace('return 1', 'return 2'))
        self.assertIs(mod.C, cls)
        self.assertIs(mod.f, function)
        self.assertIs(obj.__class__, cls)
        self.assertEqual((obj.f(), bound(), function()), (2, 2, 2))

    def test_classmethod_staticmethod_and_saved_refs(self):
        source = 'class C:\n    @classmethod\n    def c(cls):\n        return 1\n    @staticmethod\n    def s():\n        return 1\n'
        mod = self.load(source)
        c, s = mod.C.c, mod.C.s
        self.update(mod, source.replace('return 1', 'return 2'))
        self.assertEqual((c(), s(), mod.C.c(), mod.C.s()), (2, 2, 2, 2))

    def test_defaults_annotations_and_docstrings(self):
        mod = self.load('def f(a: int=1, *, b=2) -> int:\n    "old"\n    return a+b\n')
        old = mod.f
        self.update(mod, 'def f(a: str="a", *, b="b") -> str:\n    "new"\n    return a+b\n')
        self.assertEqual(old(), 'ab')
        self.assertEqual(old.__doc__, 'new')
        self.assertEqual(old.__annotations__, {'a': str, 'return': str})

    def test_same_module_inheritance_and_zero_arg_super(self):
        source = 'class B:\n    def f(self):\n        return 1\nclass C(B):\n    def f(self):\n        return super().f()+1\n'
        mod = self.load(source)
        obj, base, cls = mod.C(), mod.B, mod.C
        self.update(mod, source.replace('return 1', 'return 5') + '\n    def added(self):\n        return super().f()+2\n')
        self.assertIs(mod.C, cls)
        self.assertIs(mod.B, base)
        self.assertEqual(obj.f(), 6)
        self.assertEqual(obj.added(), 7)

    def test_properties_and_existing_saved_getter(self):
        source = 'class C:\n    @property\n    def value(self):\n        return 1\n'
        mod = self.load(source)
        obj, getter = mod.C(), mod.C.value.fget
        self.update(mod, source.replace('return 1', 'return 2'))
        self.assertEqual(obj.value, 2)
        self.assertEqual(getter(obj), 2)

    def test_add_and_remove_members(self):
        mod = self.load('class C:\n    def old(self):\n        return 1\nobsolete=1\n')
        obj = mod.C()
        self.update(mod, 'class C:\n    def new(self):\n        return 2\nadded=2\n')
        self.assertFalse(hasattr(obj, 'old'))
        self.assertFalse(hasattr(mod, 'obsolete'))
        self.assertEqual(obj.new(), 2)
        self.assertEqual(mod.added, 2)

    def test_unchanged_slots_keep_instance_state(self):
        source = 'class C:\n    __slots__=("x",)\n    def f(self):\n        return self.x+1\n'
        mod = self.load(source)
        obj = mod.C()
        obj.x = 5
        self.update(mod, source.replace('self.x+1', 'self.x+2'))
        self.assertEqual(obj.f(), 7)

    def test_changed_slots_or_bases_rejected_before_old_code_changes(self):
        source = 'def f():\n    return 1\nclass C:\n    __slots__=("x",)\n'
        mod = self.load(source)
        function = mod.f
        self.path.write_text(source.replace('return 1', 'return 2').replace('"x"', '"y"'))
        with self.assertRaises(XR.ReloadError):
            XR.xreload(mod)
        self.assertEqual(function(), 1)
        self.assertEqual(mod.C.__slots__, ('x',))

    def test_runtime_exception_restores_module_dictionary(self):
        mod = self.load('def f():\n    return 1\n')
        function = mod.f
        self.path.write_text('value=5\nraise RuntimeError("bad")\n')
        with self.assertRaises(RuntimeError):
            XR.xreload(mod)
        self.assertIs(mod.f, function)
        self.assertFalse(hasattr(mod, 'value'))
        self.assertEqual(function(), 1)

    def test_syntax_error_keeps_old_code(self):
        mod = self.load('value=1\n')
        self.path.write_text('def broken(')
        with self.assertRaises(SyntaxError):
            XR.xreload(mod)
        self.assertEqual(mod.value, 1)

    def test_preserved_globals_and_function_globals(self):
        source = '__reload_preserve__=("state",)\nstate={}\nFACTOR=1\ndef f():\n    return state, FACTOR\n'
        mod = self.load(source)
        state, function = mod.state, mod.f
        state['live']=5
        self.update(mod, source.replace('FACTOR=1', 'FACTOR=2'))
        self.assertIs(function.__globals__, mod.__dict__)
        self.assertIs(mod.state, state)
        self.assertEqual(function(), ({'live': 5}, 2))

    def test_decorator_function_closure(self):
        source = 'from functools import wraps\ndef decorate(f):\n    @wraps(f)\n    def wrapper(*args):\n        return f(*args)\n    return wrapper\n@decorate\ndef f():\n    return 1\n'
        mod = self.load(source)
        function = mod.f
        self.update(mod, source.replace('return 1', 'return 2'))
        self.assertIs(mod.f, function)
        self.assertEqual(function(), 2)
        self.assertEqual(function.__wrapped__(), 2)

    def test_relative_import_and_import_metadata(self):
        package = self.root / 'pkg'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'value.py').write_text('VALUE=7')
        self.path = package / 'subject.py'
        self.path.write_text('from .value import VALUE\ndef f():\n    return VALUE\n')
        sys.path.insert(0, str(self.root))
        try:
            mod = importlib.import_module('pkg.subject')
            self.modules.extend(['pkg', 'pkg.value', 'pkg.subject'])
            before = (mod.__name__, mod.__package__, mod.__file__, mod.__spec__)
            self.update(mod, 'from .value import VALUE\ndef f():\n    return VALUE+1\n')
            self.assertEqual(mod.f(), 8)
            self.assertEqual((mod.__name__, mod.__package__, mod.__file__, mod.__spec__), before)
        finally:
            sys.path.remove(str(self.root))

    def test_rapid_same_size_source_ignores_pyc(self):
        mod = self.load('value=1\n')
        self.update(mod, 'value=2\n')
        self.assertEqual(mod.value, 2)
        self.update(mod, 'value=3\n')
        self.assertEqual(mod.value, 3)

    def test_changed_closure_capture_is_rejected(self):
        source = 'def make(n):\n    return lambda: n\nf=make(1)\n'
        mod = self.load(source)
        function = mod.f
        self.path.write_text(source.replace('make(1)', 'make(2)'))
        with self.assertRaises(XR.ReloadError):
            XR.xreload(mod)
        self.assertIs(mod.f, function)
        self.assertEqual(function(), 1)

    def test_added_subclass_uses_retained_base(self):
        source = 'class B:\n    def f(self):\n        return 1\n'
        mod = self.load(source)
        base = mod.B
        self.update(mod, source.replace('return 1', 'return 2') + 'class C(B):\n    pass\n')
        self.assertIs(mod.C.__bases__[0], base)
        self.assertEqual(mod.C().f(), 2)

    def test_original_custom_update_hook(self):
        source = 'class C:\n    @staticmethod\n    def __reload_update__(old):\n        old.patched=1\n        return old\n'
        mod = self.load(source)
        cls = mod.C
        self.update(mod, source.replace('patched=1', 'patched=2'))
        self.assertIs(mod.C, cls)
        self.assertEqual(cls.patched, 2)

    def test_async_function_reference_updates(self):
        import asyncio
        source = 'async def f():\n    return 1\n'
        mod = self.load(source)
        function = mod.f
        self.update(mod, source.replace('return 1', 'return 2'))
        loop = asyncio.new_event_loop()
        try:
            self.assertEqual(loop.run_until_complete(function()), 2)
        finally:
            loop.close()

    def test_non_source_and_bad_argument_rejected(self):
        with self.assertRaises(TypeError):
            XR.xreload({})
        with self.assertRaises(XR.ReloadError):
            XR.xreload(sys)


if __name__ == '__main__':
    unittest.main()
