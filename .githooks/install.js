'use strict';

// Points git at .githooks for this clone only (core.hooksPath lives in
// .git/config, so nothing about the user's other repositories changes).
//
// Run by the `prepare` lifecycle script on every `pnpm install`, and safe to run
// by hand: it is idempotent and refuses to fail the install. A source tarball
// has no .git directory, and a missing hook must never be the reason a build
// stops.

const {execFileSync} = require('node:child_process');

const run = (args) => execFileSync('git', args, {encoding: 'utf8'}).trim();

const main = () => {
  let current = '';
  try {
    run(['rev-parse', '--git-dir']);
  } catch {
    console.log('commit-msg hook: not a git checkout, skipped');
    return 0;
  }

  try {
    current = run(['config', '--local', '--get', 'core.hooksPath']);
  } catch {
    current = '';
  }

  if (current === '.githooks') {
    console.log('commit-msg hook: already installed (core.hooksPath=.githooks)');
    return 0;
  }

  try {
    run(['config', '--local', 'core.hooksPath', '.githooks']);
    console.log(`commit-msg hook: installed (core.hooksPath .githooks${current ? `, was ${current}` : ''})`);
    return 0;
  } catch (error) {
    console.log(`commit-msg hook: could not be installed (${error.message.split('\n')[0]})`);
    console.log('                    commit messages are still checked by CI');
    return 0;
  }
};

process.exitCode = main();
