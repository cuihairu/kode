# Entities — one class per file (用户令 2026-11-11 / user directive: static
# template, one class per file, project copies are user-editable).
# 拆分自 _KBEngine_common.pyi(cuihairu/kbengine typings,钉点 commit 见
# typings/README.md),由 scripts/derive-kbengine-stub-typings.mjs 生成;
# 改内容请重跑派生脚本,勿手工合并 / split by the derive script — regenerate
# there, do not hand-merge.
# 共享头部是有意的:逐类裁剪易漂移,桩内多余 import 无副作用(注解经
# __future__ 惰性求值)/ generous shared header on purpose: per-class pruning
# invites drift, unused stub imports are inert.
from __future__ import annotations

from typing import (
    Any,
    BinaryIO,
    Callable,
    Dict,
    IO,
    List,
    Literal,
    Sequence,
    TextIO,
    Tuple,
    Union,
    overload,
)

from ._KBEngine_common import Address, Callback, Vector3Like, WatcherValue
from .EntityCall import EntityCall
from .EntityComponentCall import EntityComponentCall
from .MemoryStream import MemoryStream
from .GlobalDataClient import GlobalDataClient
from .Entity import Entity
from .Proxy import Proxy
from .Space import Space
from .EntityComponent import EntityComponent

class Entities(Dict[int, Entity]):
    pass
