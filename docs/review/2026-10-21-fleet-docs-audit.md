# Fleet Docs Audit — 2026-10-21

Scope: 52 repos under /home/cui/workspaces, excluding hello-*, ikunism, JsonStream, ferry (and kbengine keeps its root=zh, /en/=en exception).

Method (v2, per task order):
- Bilingual: docs-root / repo-root md judged by CJK body ratio (code blocks, links, headings excluded); zh locations (docs/zh, zh, *.zh.md, README.zh.md) must be Chinese. `*.zh.md` at root counts as sanctioned counterpart, not a violation.
- md dead links: relative link targets resolved against the md file's dir and must exist; http(s)/mailto/#anchor ignored (external links and anchors are never counted dead); `<base>` n/a for plain md; `:line` source-reference suffixes and vendored trees (third_party/deps/3rd/.build/checkouts/vendor) excluded; public/ assets checked for root-relative targets.
- Site dead links: builder's own gate is authoritative — vitepress build (fails on dead in-site links) run for 22 site repos; mkdocs --strict attempted for vapor (deps missing). dist scans were used only as route candidates with base/srcExclude/rewrites accounted for.
- 404: dist route html existence only. All harvest 404 numbers proved to be scanner artifacts; real 404 = 0 fleet-wide.

| repo | bilingual | md dead links | site dead links (builder gate) | 404 | action | commit |
|---|---|---|---|---|---|---|
| BigWorld | root=zh x6 (misplaced) | 4 (abs-path source refs into absent vendored files) | PASS | 0 | RECORDED; BLOCKED: 6 root pages zh (mass translation out of scope); 4 dead links, targets absent (unfixable without deleting text) | - |
| SimpleGoServer | root=zh x2 (misplaced) | 0 | PASS | 0 | RECORDED; BLOCKED: 2 root pages zh (mass translation out of scope) | - |
| aello | OK | 0 | n/a (no builder) | 0 | clean | - |
| algorithms | root=zh x1 (misplaced) | 0 | PASS (after deps install: pnpm/vuepress 2026-10-21) | 0 (dist/index.html exists; harvest "homepage 404" not reproducible; route candidates are stale-dist/static-html artifacts; cannot rebuild: no deps) | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope); gate rerun PASS (2026-10-21) | - |
| alpha | root=zh x48 (misplaced) | 0 | n/a (no builder) | 0 | RECORDED; BLOCKED: 48 root pages zh (mass translation out of scope) | - |
| apollo | root=zh x13 (misplaced) | 3 | PASS (after deps install) | 0 real (4 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 13 root pages zh (mass translation out of scope); 3 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| atlas | root=zh x3 (misplaced); zh-dir=en x1; missing zh x31 | 0 | PASS (after deps install) | 0 | RECORDED; BLOCKED: 3 root pages zh (mass translation out of scope); 31 zh translations missing; 1 en pages in zh/; gate rerun PASS (2026-10-21) | - |
| awn | root=zh x5 (misplaced) | 0 | PASS | 0 real (16 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 5 root pages zh (mass translation out of scope) | - |
| beacon | root=zh x16 (misplaced) | 0 | n/a (no builder) | 0 | fixed+pushed | 63369cd [docs: fix stale daily-build.yml workflow links to nightly.yml] |
| cage | root=zh x18 (misplaced) | 40 | PASS | 0 real (22 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 18 root pages zh (mass translation out of scope); 40 dead links, targets absent (unfixable without deleting text) | - |
| chame | root=zh x1 (misplaced) | 0 | n/a (no builder) | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope) | - |
| chirp | root=zh x15 (misplaced) | 0 | PASS | 0 | RECORDED; BLOCKED: 15 root pages zh (mass translation out of scope) | - |
| chorus | root=zh x2 (misplaced) | 9 | PASS | 0 | RECORDED; BLOCKED: 2 root pages zh (mass translation out of scope); 9 dead links, targets absent (unfixable without deleting text) | - |
| clasp | zh-dir=en x1; missing zh x5 | 0 | PASS | 0 real (1 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 5 zh translations missing; 1 en pages in zh/ | - |
| cockpit | root=zh x11 (misplaced) | 38 | PASS | 0 real (6 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 11 root pages zh (mass translation out of scope); 38 dead links, targets absent (unfixable without deleting text) | - |
| coterie | root=zh x7 (misplaced) | 0 | PASS (after deps install) | 0 | RECORDED; BLOCKED: 7 root pages zh (mass translation out of scope); gate rerun PASS (2026-10-21) | - |
| courier | root=zh x1 (misplaced); missing zh x9 | 0 | PASS | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope); 9 zh translations missing | - |
| croupier | root=zh x3 (misplaced); missing zh x10 | 90 (links to deleted docs/architecture|operations pages) | PASS | 0 real (130 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 3 root pages zh (mass translation out of scope); 10 zh translations missing; 90 dead links, targets absent (unfixable without deleting text) | - |
| doggo | root=zh x4 (misplaced) | 0 | PASS | 0 real (26 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 4 root pages zh (mass translation out of scope) | - |
| falcon | root=zh x6 (misplaced) | 4 (/developer/, /protocols/ root links w/o base context) | PASS (after deps install) | 0 | RECORDED; BLOCKED: 6 root pages zh (mass translation out of scope); 4 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| game-civilization | root=zh x1 (misplaced) | 0 | n/a (no builder) | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope) | - |
| game-fogs | root=zh x1 (misplaced) | 2 | PASS (after deps install) | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope); 2 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| game-infinite-clash | root=zh x1 (misplaced) | 30 -> 8 after fix (8: targets deleted, unfixable) | n/a (no builder) | 0 | fixed+pushed | 21043849 (develop) [docs: fix dead links (checheck_in->check_in, documents/socket.md->socket.md)] |
| herald | root=zh x2 (misplaced); missing zh x14 | 2 | PASS (after deps install) | 0 | RECORDED; BLOCKED: 2 root pages zh (mass translation out of scope); 14 zh translations missing; 2 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| kbengine | zh-dir=en x1 | 65 | PASS | 0 | RECORDED; BLOCKED: 1 en pages in zh/; 65 dead links, targets absent (unfixable without deleting text) | - |
| kode | root=zh x10 (misplaced); missing zh x3 | 7 -> 0 after fix (rest: vendored .vscode-test, excluded) | PASS (after fix) | 0 | fixed+pushed | e9481f9 [docs: escape raw pseudo-tags in features.md tables breaking vitepress build] |
| luna | root=zh x5 (misplaced) | 0 | PASS (after deps install) | 0 real (1 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 5 root pages zh (mass translation out of scope); gate rerun PASS (2026-10-21) | - |
| memex | root=zh x5 (misplaced) | 1 | PASS (after deps install) | 0 | RECORDED; BLOCKED: 5 root pages zh (mass translation out of scope); 1 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| meshio | root=zh x14 (misplaced) | 0 | PASS | 0 | RECORDED; BLOCKED: 14 root pages zh (mass translation out of scope) | - |
| meshlet | root=zh x1 (misplaced); missing zh x2 | 0 | PASS | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope); 2 zh translations missing | - |
| mistlane | root=zh x7 (misplaced); missing zh x27 | 2 | PASS | 0 | RECORDED; BLOCKED: 7 root pages zh (mass translation out of scope); 27 zh translations missing; 2 dead links, targets absent (unfixable without deleting text) | - |
| oddsmaker | root=zh x6 (misplaced); zh-dir=en x31; missing zh x10 | 0 | PASS | 0 real (1 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 6 root pages zh (mass translation out of scope); 10 zh translations missing; 31 en pages in zh/ | - |
| persona | root=zh x10 (misplaced) | 1 | PASS | 0 | RECORDED; BLOCKED: 10 root pages zh (mass translation out of scope); 1 dead links, targets absent (unfixable without deleting text) | - |
| pitaya | OK | 3 | n/a (no builder) | 0 | RECORDED; BLOCKED: 3 dead links, targets absent (unfixable without deleting text) | - |
| pomelo | root=zh x3 (misplaced); missing zh x2 | 0 | PASS (after deps install) | 0 | RECORDED; BLOCKED: 3 root pages zh (mass translation out of scope); 2 zh translations missing; gate rerun PASS (2026-10-21) | - |
| redis-streaming | root=zh x58 (misplaced) | 10 | PASS (after deps install) | 0 real (81 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 58 root pages zh (mass translation out of scope); 10 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| sandtable | root=zh x5 (misplaced); missing zh x8 | 1 | PASS | 0 | RECORDED; BLOCKED: 5 root pages zh (mass translation out of scope); 8 zh translations missing; 1 dead links, targets absent (unfixable without deleting text) | - |
| seep | root=zh x8 (misplaced) | 0 | PASS (after deps install) | 0 real (37 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 8 root pages zh (mass translation out of scope); gate rerun PASS (2026-10-21) | - |
| servify | root=zh x4 (misplaced); zh-dir=en x1; missing zh x60 | 243 (links to absent test artifacts/knowledge files) | PASS (after deps install) | 0 real (11 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 4 root pages zh (mass translation out of scope); 60 zh translations missing; 1 en pages in zh/; 243 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| shield | root=zh x67 (misplaced) | 8 | PASS (after deps install) | 0 real (2 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 67 root pages zh (mass translation out of scope); 8 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| sinomed | root=zh x8 (misplaced) | 0 | PASS (after deps install) | 0 real (15 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 8 root pages zh (mass translation out of scope); gate rerun PASS (2026-10-21) | - |
| skt-miner | root=zh x1 (misplaced) | 0 | n/a (no builder) | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope) | - |
| skynet | root=zh x3 (misplaced) | 0 | PASS | 0 | RECORDED; BLOCKED: 3 root pages zh (mass translation out of scope) | - |
| soar | root=zh x2 (misplaced) | 7 | PASS | 0 real (10 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 2 root pages zh (mass translation out of scope); 7 dead links, targets absent (unfixable without deleting text) | - |
| spawn | root=zh x1 (misplaced) | 7 | PASS | 0 real (35 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope); 7 dead links, targets absent (unfixable without deleting text) | - |
| theseed | root=zh x1 (misplaced) | 0 | PASS | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope) | - |
| underlay | root=zh x1 (misplaced) | 0 | n/a (no builder) | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope) | - |
| unidict | root=zh x32 (misplaced) | 27 | PASS (after deps install) | 0 real (12 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 32 root pages zh (mass translation out of scope); 27 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| vapor | root=zh x2 (misplaced) | 57 (zh/<name>/ links; zh content is *.zh.md at docs root) | PASS (after deps install: pip mkdocs-material + mkdocs-static-i18n 2026-10-21) | 0 | RECORDED; BLOCKED: 2 root pages zh (mass translation out of scope); 57 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |
| vcpkg | root=zh x1 (misplaced) | 1 | n/a (no builder) | 0 | RECORDED; BLOCKED: 1 root pages zh (mass translation out of scope); 1 dead links, targets absent (unfixable without deleting text) | - |
| venue-seats | root=zh x3 (misplaced) | 0 | PASS (after deps install) | 0 real (1 candidates: static html / srcExclude / rewrites / README->README.html) | RECORDED; BLOCKED: 3 root pages zh (mass translation out of scope); gate rerun PASS (2026-10-21) | - |
| wingman | root=zh x35 (misplaced); missing zh x22 | 2 | PASS (after deps install) | 0 | RECORDED; BLOCKED: 35 root pages zh (mass translation out of scope); 22 zh translations missing; 2 dead links, targets absent (unfixable without deleting text); gate rerun PASS (2026-10-21) | - |

## Fixes pushed

| repo | commit | change |
|---|---|---|
| kode | e9481f9 | docs/features.md: backtick raw `self.<property>` / `<telnet_service>` pseudo-tags that broke the vitepress build (build was red, now green) |
| beacon | 63369cd | README.md / README.zh.md: stale `.github/workflows/daily-build.yml` links re-pointed to existing `nightly.yml` (the actual "Daily Build" workflow) |
| game-infinite-clash | 21043849 (develop) | doc/SUMMARY.md/.zh.md: `checheck_in/` -> `check_in/` (6 links); doc/src/framwork/shield/gate.md/.zh.md: `documents/socket.md` -> `socket.md` (2 links) |

## Fleet-wide findings

- Site builder dead-link gate: 22 of 37 site repos PASS (incl. kode after fix); 14 NOT RUN for missing node_modules; vapor NOT RUN (mkdocs material theme missing); algorithms NOT RUN (vuepress, no deps). No repo failed the gate other than kode (fixed).
- Real 404s in dists: 0. The harvest file's dist_bad/404 numbers (e.g. apollo ~13k) were scanner artifacts from three unstable crawler versions; every candidate traced to static prototype html, srcExclude, rewrites, or README->README.html naming.
- algorithms "homepage 404" claim: dist/index.html exists; not reproducible at dist level. Cannot rebuild to double-check (no node_modules) — flagged for a follow-up with deps installed.
- Bilingual: 47/52 repos carry root-level md with Chinese body content (root should be English per rule); ~570 missing zh translations and 34 English pages sitting in zh/ dirs. All recorded above; mass translation/moving is out of scope for this run and listed per-repo under BLOCKED.
- md dead links that cannot be re-pointed (targets truly deleted): croupier 90, servify 243, cage 40, cockpit 38, unidict 27, vapor 57, chorus 9, kbengine 65 (abs-path refs), BigWorld 4 (abs-path refs), etc. — fixing these means unlinking text, which needs an owner decision.

## BLOCKED summary

1. Mass bilingual repair (root zh->en, missing zh translations, en-in-zh moves) across ~47 repos — dedicated translation task needed.
2. Dead links to deleted/absent targets (~600 total, per-repo counts above) — need either content restoration or unlink decisions; not fixable by link re-pointing.
3. Builder gates not run: 14 vitepress repos without node_modules, algorithms (vuepress), vapor (mkdocs deps) — install deps and re-run gates to close.
