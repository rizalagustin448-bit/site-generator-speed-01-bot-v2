import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking');
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import('./solve.js').then(({ run }) => {
  const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
  const answers = cases.map((c) => run(c.input ?? c));
  mkdirSync('/output', { recursive: true });
  writeFileSync('/output/answers.json', JSON.stringify(answers));
});
