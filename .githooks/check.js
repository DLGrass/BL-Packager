'use strict';

// Entry point shared by the commit-msg hook and the CI job.
//
//   node .githooks/check.js <message-file>     what the hook passes
//   node .githooks/check.js --range <from> <to>   what CI passes (git rev range)
//   node .githooks/check.js --stdin            for one-off checks
//
// Exit codes: 0 everything complies, 1 something does not, 2 the arguments were
// wrong (kept distinct so CI logs tell "bad message" apart from "bad workflow").

const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {checkMessage, HELP} = require('./conventional');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const git = (args) => execFileSync('git', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});

// `git log` is asked for the message body only; the subject is what the rule
// looks at, and --no-merges keeps git's own merge commits out of the gate.
const commitsInRange = (from, to) => {
  let base = from;
  try {
    git(['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
  } catch {
    // A fresh branch reports an all-zero "before" that names no object, and
    // workflow_dispatch reports nothing at all. Falling back to the tip is the
    // only honest answer: walking the whole history would just re-flunk the
    // commits that predate this rule, which is not what the gate is for.
    try {
      base = git(['rev-parse', '--verify', '--quiet', 'HEAD^']).trim();
    } catch {
      base = EMPTY_TREE;
    }
  }
  const raw = git(['log', '--no-merges', '--format=%B%x00', `${base}..${to}`]);
  return raw
    .split('\u0000')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '');
};

const report = (failures) => {
  for (const {header, reason} of failures) {
    console.error(`FAIL  ${header}`);
    console.error(`      ${reason}`);
  }
  if (failures.length > 0) console.error(HELP);
  return failures.length === 0 ? 0 : 1;
};

const main = (argv) => {
  if (argv[0] === '--range') {
    // `--range "" <to>` is what the workflow passes on workflow_dispatch; some
    // shells drop the empty argument entirely, so an absent `from` is the same
    // thing as an empty one, not a usage error.
    if (argv.length < 2) {
      console.error('usage: check.js --range <from> <to>');
      return 2;
    }
    const messages = commitsInRange(argv[1] || '', argv[2] || 'HEAD');
    if (messages.length === 0) {
      console.log('commit messages: nothing new to check');
      return 0;
    }
    const results = messages.map((message) => checkMessage(message));
    for (const result of results) {
      if (result.ok) console.log(`ok    ${result.header}${result.exempt ? '  (exempt)' : ''}`);
    }
    return report(results.filter((result) => !result.ok));
  }

  const source = argv[0] === '--stdin' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(argv[0], 'utf8');
  const result = checkMessage(source);
  if (!result.ok) return report([result]);
  console.log(`ok    ${result.header}`);
  return 0;
};

if (require.main === module) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    code = 2;
  }
  // Flushing first: when stdout is a pipe (every CI log), an immediate exit can
  // lose the tail of the report.
  process.stdout.write('', () => process.exit(code));
}

module.exports = {commitsInRange};
