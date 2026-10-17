'use strict';

// Conventional Commits, enforced by a hook and by CI.
//
// The rule lives here rather than inside the hook so that it can be asserted in
// test/run.js in the same way as the rest of this repository's logic. The hook
// (.githooks/commit-msg) and the CI gate (.github/workflows/ci.yml) both call
// this file, so "it passed locally" and "it passed on the runner" cannot drift.
//
// Accepted header:  type(scope)!: subject
//
//   type    one of TYPES, lowercase
//   scope   optional, lowercase letters/digits/./_/-
//   !       optional, marks a breaking change
//   subject imperative, non-empty, no trailing period, header <= 72 chars
//
// Exempt, because git writes them itself or because they are rebase plumbing:
// merge commits, `Revert "..."`, and `fixup!` / `squash!` / `amend!`.

const TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test'
];

const HEADER = /^([a-z]+)(?:\(([^()\s]+)\))?(!)?: (\S.*)$/;
const MAX_HEADER = 72;
const EXEMPT = [
  /^Merge /,
  /^Revert "/,
  /^fixup! /,
  /^squash! /,
  /^amend! /
];

const stripComments = (text, commentChar) =>
  // git prefixes its instructions with the comment char (usually '#'). The
  // scissors line cuts everything below it during `commit -v`.
  text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(commentChar) && !/^------------------------ >8/.test(line))
    .join('\n')
    .replace(/\s+$/, '');

const subjectOf = (text, commentChar) => {
  const body = stripComments(String(text), commentChar || '#');
  const first = body.split(/\r?\n/).find((line) => line.trim() !== '');
  return first === undefined ? '' : first.trim();
};

/**
 * Validate one commit message.
 * @param {string} text   full message text (the file git hands the hook)
 * @param {object} [options]
 * @param {string} [options.commentChar]  core.commentChar, default '#'
 * @returns {{ok: true, header: string} | {ok: false, header: string, reason: string}}
 */
const checkMessage = (text, options) => {
  const opts = options || {};
  const header = subjectOf(text, opts.commentChar);

  if (header === '') {
    return {ok: false, header, reason: 'the message is empty'};
  }
  for (const pattern of EXEMPT) {
    if (pattern.test(header)) return {ok: true, header, exempt: true};
  }
  if (header.length > MAX_HEADER) {
    return {
      ok: false,
      header,
      reason: `the header is ${header.length} characters; the limit is ${MAX_HEADER}`
    };
  }

  const match = HEADER.exec(header);
  if (!match) {
    return {
      ok: false,
      header,
      reason: 'the header is not `type(scope): subject`'
    };
  }

  const type = match[1];
  if (!TYPES.includes(type)) {
    return {
      ok: false,
      header,
      reason: `\`${type}\` is not a type; use one of ${TYPES.join(', ')}`
    };
  }

  const subject = match[4];
  if (/[.。]$/.test(subject)) {
    return {ok: false, header, reason: 'the subject ends with a period'};
  }
  if (subject.length < 3) {
    return {ok: false, header, reason: 'the subject is too short to describe anything'};
  }

  return {ok: true, header};
};

const HELP = [
  '',
  'A commit message must read:  type(scope): subject',
  '',
  `  type      ${TYPES.join(' | ')}`,
  '  scope     optional, e.g. feat(ui):',
  '  subject   imperative, no trailing period, header <= 72 characters',
  '',
  '  examples  feat(ui): publish the download link on the status line',
  '            fix: stop dropping the last line of the probe output',
  '            ci(release): attach the source archive to the tag',
  '',
  'Merge commits, `Revert "..."` and rebase fixups are exempt.',
  'To skip this once: git commit --no-verify',
  ''
].join('\n');

module.exports = {TYPES, MAX_HEADER, checkMessage, subjectOf, HELP};
