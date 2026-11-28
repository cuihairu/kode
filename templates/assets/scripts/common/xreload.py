# -*- coding: utf-8 -*-
"""Python 3.7.3 adaptation of Guido van Rossum's xreload.

Source: https://svn.python.org/projects/sandbox/trunk/xreload/xreload.py
The original algorithm executes in the original module dictionary and patches
functions/classes in place. This adaptation replaces imp/ClassType/im_func,
preserves import metadata, preflights layouts, supports Python 3 descriptors,
and maps newly created class references back to the live classes.

Limits: native/zip modules and custom metaclasses require restart. This is not
a transaction over arbitrary module side effects. Active frames/generators keep
their current code. Mutable module globals are replaced unless explicitly named
in __reload_preserve__; instance state is retained, not automatically migrated.
Other modules' imported constants are not updated by xreload itself.
"""
from pathlib import Path
import types


class ReloadError(RuntimeError):
    """An unsupported update needs a process restart."""


_METADATA = ("__name__", "__file__", "__package__", "__loader__", "__spec__",
             "__builtins__", "__cached__", "__path__")
_PROTECTED = {"__dict__", "__weakref__", "__classcell__", "__slots__",
              "__firstlineno__", "__static_attributes__"}


def _slots(cls):
    value = cls.__dict__.get("__slots__", ())
    return (value,) if isinstance(value, str) else tuple(value)


def _class_pairs(old, new, pairs):
    if old is new or not isinstance(old, type) or not isinstance(new, type):
        return
    if type(old) is not type or type(new) is not type:
        raise ReloadError("custom metaclass requires restart: " + old.__name__)
    if id(new) in pairs:
        return
    pairs[id(new)] = (old, new)
    for name in set(old.__dict__) & set(new.__dict__):
        _class_pairs(old.__dict__[name], new.__dict__[name], pairs)


def _mapped(value, pairs):
    pair = pairs.get(id(value))
    return pair[0] if pair is not None else value


def _validate(old, new, pairs, seen):
    key = (id(old), id(new))
    if old is new or key in seen:
        return
    seen.add(key)
    if type(old) is not type(new):
        if isinstance(old, (types.FunctionType, type, property, classmethod, staticmethod)):
            raise ReloadError("live definition changed kind; restart required")
        return
    if isinstance(old, type):
        bases = tuple(_mapped(base, pairs) for base in new.__bases__)
        if old.__bases__ != bases or _slots(old) != _slots(new):
            raise ReloadError("class bases/slots changed; restart required: " + old.__name__)
        for name in set(old.__dict__) & set(new.__dict__) - _PROTECTED:
            _validate(old.__dict__[name], new.__dict__[name], pairs, seen)
    elif isinstance(old, types.FunctionType):
        if old.__code__.co_freevars != new.__code__.co_freevars:
            raise ReloadError("closure layout changed; restart required: " + old.__name__)
        for oldcell, newcell in zip(old.__closure__ or (), new.__closure__ or ()):
            try:
                a, b = oldcell.cell_contents, newcell.cell_contents
            except ValueError:
                continue
            if isinstance(a, types.FunctionType) and isinstance(b, types.FunctionType):
                _validate(a, b, pairs, seen)
            elif a is not _mapped(b, pairs) and a != _mapped(b, pairs):
                raise ReloadError("captured closure value changed; restart required")
    elif isinstance(old, (classmethod, staticmethod)):
        _validate(old.__func__, new.__func__, pairs, seen)
    elif isinstance(old, property):
        for a, b in zip((old.fget, old.fset, old.fdel), (new.fget, new.fset, new.fdel)):
            if a is not None and b is not None:
                _validate(a, b, pairs, seen)


def _cell(value):
    return (lambda: value).__closure__[0]


def _new_value(value, pairs):
    mapped = _mapped(value, pairs)
    if mapped is not value:
        return mapped
    if isinstance(value, type) and type(value) is type:
        bases = tuple(_mapped(base, pairs) for base in value.__bases__)
        if bases != value.__bases__:
            value.__bases__ = bases
        return value
    if isinstance(value, types.FunctionType):
        # New methods using zero-argument super() must close over the LIVE class.
        cells = tuple(_cell(_mapped(c.cell_contents, pairs)) for c in value.__closure__ or ())
        if cells:
            result = types.FunctionType(value.__code__, value.__globals__, value.__name__,
                                        value.__defaults__, cells)
            result.__dict__.update(value.__dict__)
            result.__kwdefaults__ = value.__kwdefaults__
            result.__annotations__ = value.__annotations__
            result.__qualname__ = value.__qualname__
            result.__module__ = value.__module__
            result.__doc__ = value.__doc__
            return result
    if isinstance(value, classmethod):
        return classmethod(_new_value(value.__func__, pairs))
    if isinstance(value, staticmethod):
        return staticmethod(_new_value(value.__func__, pairs))
    if isinstance(value, property):
        return property(*(_new_value(f, pairs) if f else None
                          for f in (value.fget, value.fset, value.fdel)), doc=value.__doc__)
    return value


def _update(old, new, pairs, seen):
    if old is new:
        return old
    key = (id(old), id(new))
    if key in seen:
        return old
    seen.add(key)
    if type(old) is not type(new):
        return _new_value(new, pairs)
    hook = getattr(new, "__reload_update__", None)
    if callable(hook):
        return hook(old)
    if isinstance(old, types.FunctionType):
        for a, b in zip(old.__closure__ or (), new.__closure__ or ()):
            try:
                before, after = a.cell_contents, b.cell_contents
            except ValueError:
                continue
            if isinstance(before, types.FunctionType) and isinstance(after, types.FunctionType):
                _update(before, after, pairs, seen)
        old.__code__ = new.__code__
        old.__defaults__ = (tuple(_mapped(v, pairs) for v in new.__defaults__)
                            if new.__defaults__ is not None else None)
        old.__kwdefaults__ = ({k: _mapped(v, pairs) for k, v in new.__kwdefaults__.items()}
                              if new.__kwdefaults__ is not None else None)
        old.__annotations__ = {k: _mapped(v, pairs) for k, v in new.__annotations__.items()}
        old.__doc__ = new.__doc__
        old.__dict__.update(new.__dict__)
        if hasattr(old, "__wrapped__") and hasattr(new, "__wrapped__"):
            old.__wrapped__ = _update(old.__wrapped__, new.__wrapped__, pairs, seen)
        return old
    if isinstance(old, type):
        before, after = dict(old.__dict__), dict(new.__dict__)
        for name in set(before) - set(after) - _PROTECTED:
            delattr(old, name)
        for name in set(after) - _PROTECTED:
            value = (_update(before[name], after[name], pairs, seen) if name in before
                     else _new_value(after[name], pairs))
            setattr(old, name, value)
        return old
    if isinstance(old, (classmethod, staticmethod)):
        _update(old.__func__, new.__func__, pairs, seen)
        return old
    if isinstance(old, property):
        values = [(_update(a, b, pairs, seen) if a is not None and b is not None
                   else _new_value(b, pairs) if b else None)
                  for a, b in zip((old.fget, old.fset, old.fdel), (new.fget, new.fset, new.fdel))]
        return property(*values, doc=new.__doc__)
    if isinstance(old, (types.MemberDescriptorType, types.GetSetDescriptorType)):
        return old  # The descriptor belongs to the retained live class layout.
    if isinstance(old, types.MethodType):
        _update(old.__func__, new.__func__, pairs, seen)
        return old
    return _new_value(new, pairs)


def xreload(module, source=None):
    """Update a loaded source module in place; return that same module object."""
    if not isinstance(module, types.ModuleType):
        raise TypeError("xreload expects a module")
    filename = getattr(module, "__file__", None)
    if not filename or not filename.endswith(".py"):
        raise ReloadError("xreload requires a Python source module")
    # Read source directly: no timestamp/size .pyc cache race on rapid saves.
    code = compile(Path(filename).read_bytes() if source is None else source, filename, "exec", dont_inherit=True)
    namespace = module.__dict__
    previous = namespace.copy()
    preserve = previous.get("__reload_preserve__", ())
    if not isinstance(preserve, (tuple, list)) or not all(isinstance(n, str) for n in preserve):
        raise ReloadError("__reload_preserve__ must be a list/tuple of global names")
    namespace.clear()
    namespace.update({key: previous[key] for key in _METADATA if key in previous})
    pairs = {}
    try:
        exec(code, namespace)
        for name in set(previous) & set(namespace):
            _class_pairs(previous[name], namespace[name], pairs)
        for name in set(previous) & set(namespace) - set(preserve):
            _validate(previous[name], namespace[name], pairs, set())
    except BaseException:
        namespace.clear()
        namespace.update(previous)
        raise
    seen = set()
    for name in list(namespace):
        if name in preserve and name in previous:
            namespace[name] = previous[name]
        elif name in previous:
            namespace[name] = _update(previous[name], namespace[name], pairs, seen)
        else:
            namespace[name] = _new_value(namespace[name], pairs)
    return module
