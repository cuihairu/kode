# kode KBEngine 桩包(用户令 2026-11-11:静态模板、一类一文件、copy-if-absent)
# kode KBEngine stub package (static template, one class per file,
# copy-if-absent — project copies are user-editable).
# 派生自 cuihairu/kbengine typings(钉点 commit 见 typings/README.md),由
# scripts/derive-kbengine-stub-typings.mjs 生成;改内容请重跑,勿手工合并 /
# derived by the derive script; regenerate there, do not hand-merge.
#
# 下面 re-export 顺序是有意设计,可改 / re-export order is intentional and editable:
#   1. 进程层:server_errors -> pythonapp -> baseapp/cellapp/dbmgr/
#      interfaces/logger/loginapp -> bots(后层压前层同名),
#   2. 公共超集随后 / the common superset after them,
#   3. 类文件最后 re-export:服务端 Entity/Proxy 模型压过 bots 层同名客户端
#      模型(bots 的 Entity 仍在 _KBEngine_bots 上,此处有意遮蔽)/ per-class
#      files LAST so the server Entity/Proxy models win over the bots-layer
#      client models of the same names.
# 项目需要另一套模型时,改下面顺序即可翻转遮蔽 / edit the order to flip shadowing.
from ._KBEngine_server_errors import *
from ._KBEngine_pythonapp import *
from ._KBEngine_baseapp import *
from ._KBEngine_cellapp import *
from ._KBEngine_dbmgr import *
from ._KBEngine_interfaces import *
from ._KBEngine_logger import *
from ._KBEngine_loginapp import *
from ._KBEngine_bots import *
from ._KBEngine_common import *
from ._vectors import Vector2, Vector3, Vector4
from .Entity import Entity
from .Proxy import Proxy
from .Space import Space
from .EntityCall import EntityCall
from .EntityComponentCall import EntityComponentCall
from .EntityComponent import EntityComponent
from .MemoryStream import MemoryStream
from .GlobalDataClient import GlobalDataClient
from .Entities import Entities

from typing import Any


def __getattr__(name: str) -> Any:
    ...
