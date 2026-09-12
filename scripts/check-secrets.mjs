// Fails if a credential looks like it has been committed. The repo is public,
// and a key that reaches a public remote is compromised even if the next commit
// removes it - the object stays reachable and the crawlers are fast. This runs
// first in CI, before install, so the answer arrives in seconds.
//
// Deliberately only high-signal patterns: no entropy heuristic. The track
// geometry is thousands of long numeric literals and every entropy check worth
// the name lights up on them, and a noisy guard is one people learn to skip.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

// Filenames that are gitignored for a reason. Tracking one is the failure
// regardless of what is inside it.
const FORBIDDEN_PATHS = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.local$/,
  /(^|\/)\.env\.[^/]*$/, // .env.production and friends
  /credentials.*\.env$/,
];
const PATH_ALLOW = [/(^|\/)\.env\.example$/];

const PATTERNS = [
  { name: 'Google/Gemini API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'ElevenLabs API key', re: /\bsk_[0-9a-f]{32,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  {
    name: 'MongoDB connection string with password',
    re: /mongodb(\+srv)?:\/\/[^\s:/]+:[^\s@/]+@/,
    // .env.example documents the shape with user:pass, which is the point of it.
    skip: (file, match) =>
      /(^|\/)\.env\.example$/.test(file) || /:(pass|password|<[^>]+>|x{3,})@/i.test(match),
  },
];

const MAX_BYTES = 1024 * 1024;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const findings = [];

for (const file of files) {
  if (FORBIDDEN_PATHS.some((re) => re.test(file)) && !PATH_ALLOW.some((re) => re.test(file))) {
    findings.push({ file, line: 0, what: 'env file is tracked (must stay gitignored)' });
    continue;
  }

  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue; // deleted-but-staged, or a symlink to nowhere
  }
  if (size > MAX_BYTES) continue;

  const buf = readFileSync(file);
  if (buf.includes(0)) continue; // binary: the mp3 phrase bank, the car sprites
  const text = buf.toString('utf8');

  for (const { name, re, skip } of PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = global.exec(text)) !== null) {
      if (skip?.(file, m[0])) continue;
      findings.push({
        file,
        line: text.slice(0, m.index).split('\n').length,
        what: `${name}: ${m[0].slice(0, 12)}...`,
      });
    }
  }
}

if (findings.length === 0) {
  console.log(`scanned ${files.length} tracked files - no committed credentials found`);
  process.exit(0);
}

console.error('FAIL - possible committed credentials:\n');
for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.what}`);
console.error(
  '\nIf this is a real key, treat it as compromised: revoke and reissue it first,\n' +
    'then remove it from history. A follow-up commit is not enough.',
);
process.exit(1);
