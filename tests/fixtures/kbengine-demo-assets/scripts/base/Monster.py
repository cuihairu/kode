# -*- coding: utf-8 -*-
from Avatar import Avatar


# Monster cell-only entity, base-side class (entities.xml: hasCell).
# The engine's isLoadScriptModule check requires the module to import on
# the baseapp once the bag component module (Inventory, inherited through
# the Avatar parent chain) loads there; the inherited Avatar base-face
# methods then must resolve on this class via checkDefMethod. Script-level
# inheritance mirrors the def-level <Parent> chain (same pattern as
# scripts/cell/Monster.py). Monster never has a base part in play: all
# behavior lives in scripts/cell/Monster.py.
class Monster(Avatar):
	pass
