# site-generator-speed-01 — fast static site builder (v2)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D%2022-brightgreen.svg)](https://nodejs.org/)
[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0: `run(input)` returns the
same output tree the reference build returns, byte for byte, on every input —
only quicker. Version 2 is about 16% faster than v1 on the local bench
(692.799 µs net vs 823.096 µs) and about 2× the house baseline.

## How it is faster

- Inline text is scanned in whole segments instead of one character at a
  time: a plain run goes through a single escape, so `escapeHtml` and the
  string garbage it used to make nearly disappear.
- Blocks are lexed and rendered in one walk — no token list in between.
- Words are counted without building an array; slugs are remembered per
  case; heading/trim work is done by hand instead of regexes.
- Templates render into one parts array with a single `join()` per page.
- v2 adds: regex-based escaping, a regex markup scan, static include
  caching, lines-based markdown, and `{"type": "module"}` so Node skips the
  ESM reparse overhead.

## Entry

- `solve.js` — the builder (`run(input)`).
- `main.ts` — reads `/input/cases.json`, writes `/output/answers.json`.
