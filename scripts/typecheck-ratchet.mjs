#!/usr/bin/env node
/**
 * Fails if `tsc --noEmit` error count exceeds scripts/typecheck-baseline.json maxErrors.
 * Prints categorized error-code counts to guide incremental cleanup.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const baselinePath = path.join(root, 'scripts/typecheck-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

let output = '';
try {
  execSync('npx tsc --noEmit', { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
} catch (err) {
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
}

const matches = output.match(/error (TS\d+)/g) ?? [];
const count = matches.length;
const byCode = {};
for (const m of matches) {
  byCode[m] = (byCode[m] ?? 0) + 1;
}

const sorted = Object.entries(byCode).sort((a, b) => b[1] - a[1]);
console.log(`typecheck:all — ${count} error(s) (baseline max: ${baseline.maxErrors})`);
if (sorted.length > 0) {
  console.log('by code:', sorted.map(([code, n]) => `${code}=${n}`).join(', '));
}

if (count > baseline.maxErrors) {
  console.error(
    `\nTypecheck ratchet failed: ${count} > ${baseline.maxErrors}. Fix errors or lower the baseline intentionally.`
  );
  process.exit(1);
}
