import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHumanSummary,
  extractJsonObject,
  parseModelReview,
  partitionFindingsByDiffEligibility,
  shouldFailBySeverity,
  sortFindingsBySeverity,
} from '../src/review-core.js';

test('extractJsonObject handles wrapped markdown output', () => {
  const raw = '```json\n{"summary":"ok","findings":[]}\n```';
  const extracted = extractJsonObject(raw);
  assert.equal(extracted, '{"summary":"ok","findings":[]}');
});

test('parseModelReview validates and normalizes findings', () => {
  const raw = JSON.stringify({
    summary: ' Found issues ',
    findings: [
      {
        severity: 'high',
        path: 'src/app.js',
        line: 10,
        title: 'Null dereference',
        body: 'Could throw in runtime.',
        suggested_fix: 'Guard for null before access.',
      },
    ],
  });

  const parsed = parseModelReview(raw);
  assert.equal(parsed.summary, 'Found issues');
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].end_line, 10);
});

test('parseModelReview throws on invalid severity', () => {
  const raw = JSON.stringify({
    summary: 'x',
    findings: [{ severity: 'critical', path: 'a.js', line: 1, title: 'x', body: 'y' }],
  });

  assert.throws(() => parseModelReview(raw), /severity/);
});

test('parseModelReview throws on malformed JSON', () => {
  const raw = '{"summary":"x","findings":[';
  assert.throws(() => parseModelReview(raw), /(invalid|locate)/i);
});

test('sortFindingsBySeverity sorts high to low', () => {
  const findings = [
    { severity: 'low' },
    { severity: 'high' },
    { severity: 'medium' },
  ];

  const sorted = sortFindingsBySeverity(findings);
  assert.deepEqual(sorted.map((f) => f.severity), ['high', 'medium', 'low']);
});

test('buildHumanSummary renders no issues text', () => {
  assert.equal(buildHumanSummary('No issues found.', []), 'No issues found.');
});

test('shouldFailBySeverity respects threshold', () => {
  const findings = [
    { severity: 'low' },
    { severity: 'medium' },
  ];

  assert.equal(shouldFailBySeverity(findings, 'high'), false);
  assert.equal(shouldFailBySeverity(findings, 'medium'), true);
});

test('partitionFindingsByDiffEligibility rejects finding when path is not in diff', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,1 +1,2 @@',
    ' const a = 1;',
    '+const b = 2;',
  ].join('\n');

  const findings = [
    { severity: 'high', path: 'src/other.js', line: 2, end_line: 2, title: 'x', body: 'y', suggested_fix: '' },
  ];

  const result = partitionFindingsByDiffEligibility(findings, diff);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'path-not-in-diff');
});

test('partitionFindingsByDiffEligibility rejects finding when line is outside added lines', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -10,2 +10,3 @@',
    ' const a = 1;',
    '+const b = 2;',
    ' const c = 3;',
  ].join('\n');

  const findings = [
    { severity: 'medium', path: 'src/a.js', line: 10, end_line: 10, title: 'x', body: 'y', suggested_fix: '' },
  ];

  const result = partitionFindingsByDiffEligibility(findings, diff);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'line-not-in-added-lines');
});

test('partitionFindingsByDiffEligibility accepts finding on added line', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,1 +1,2 @@',
    ' const a = 1;',
    '+const b = 2;',
  ].join('\n');

  const findings = [
    { severity: 'low', path: 'src/a.js', line: 2, end_line: 2, title: 'x', body: 'y', suggested_fix: '' },
  ];

  const result = partitionFindingsByDiffEligibility(findings, diff);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
});
