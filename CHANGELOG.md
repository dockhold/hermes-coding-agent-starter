# Changelog

Each entry names the Hermes Agent release this starter pins and says
whether moving to it changes anything on App storage.

## v0.22.6 (2026-11-03)

Initial release. Pins Hermes Agent v0.22.6, installed from its release tag
with the dependency versions of its lock file, on Python 3.14 (the version
upstream builds with) and SQLite 3.53.4 (Hermes needs 3.51.3 or newer),
with Node 22.23.4 for this starter's program, the official release checked
against a pinned sha256, and tini as process 1. Base images are pinned by
digest. App storage layout: `repo/` (the checkout), `home/` (the agent's
home folder and Hermes's home in `home/.hermes`, emptied at the start of
every task), `tasks.jsonl` (the task log) and, during a task,
`current.json`.
