const SEVERITY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function extractJsonObject(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('Model output is empty; expected JSON object.');
  }

  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return rawText.slice(start, end + 1);
  }

  throw new Error('Could not locate a JSON object in model output.');
}

function validateSeverity(severity, index) {
  if (!Object.hasOwn(SEVERITY_RANK, severity)) {
    throw new Error(`findings[${index}].severity must be one of: high, medium, low.`);
  }
}

function normalizeLineNumber(line, fieldName, index) {
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`findings[${index}].${fieldName} must be an integer >= 1.`);
  }
  return line;
}

function normalizeFinding(input, index) {
  if (!isObject(input)) {
    throw new Error(`findings[${index}] must be an object.`);
  }

  validateSeverity(input.severity, index);

  if (typeof input.path !== 'string' || input.path.trim() === '') {
    throw new Error(`findings[${index}].path must be a non-empty string.`);
  }

  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new Error(`findings[${index}].title must be a non-empty string.`);
  }

  if (typeof input.body !== 'string' || input.body.trim() === '') {
    throw new Error(`findings[${index}].body must be a non-empty string.`);
  }

  const line = normalizeLineNumber(input.line, 'line', index);
  const endLine = input.end_line === undefined ? line : normalizeLineNumber(input.end_line, 'end_line', index);
  if (endLine < line) {
    throw new Error(`findings[${index}].end_line must be >= line.`);
  }

  return {
    severity: input.severity,
    path: input.path,
    line,
    end_line: endLine,
    title: input.title.trim(),
    body: input.body.trim(),
    suggested_fix: typeof input.suggested_fix === 'string' ? input.suggested_fix.trim() : '',
  };
}

export function parseModelReview(rawText) {
  const jsonText = extractJsonObject(rawText);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Model output JSON is invalid.');
  }

  if (!isObject(parsed)) {
    throw new Error('Top-level JSON value must be an object.');
  }

  if (typeof parsed.summary !== 'string') {
    throw new Error('summary must be a string.');
  }

  if (!Array.isArray(parsed.findings)) {
    throw new Error('findings must be an array.');
  }

  const findings = parsed.findings.map((item, index) => normalizeFinding(item, index));
  return {
    summary: parsed.summary.trim(),
    findings,
  };
}

export function parseDiffChangedLineMap(diffText) {
  const map = new Map();
  const lines = String(diffText || '').split('\n');

  let currentFile = null;
  let newLine = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (line.startsWith('diff --git ')) {
      currentFile = null;
      newLine = null;
      const match = /^diff --git a\/.* b\/(.+)$/.exec(line);
      if (match) {
        currentFile = match[1];
        if (!map.has(currentFile)) {
          map.set(currentFile, new Set());
        }
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      const candidate = line.slice(4).trim();
      if (candidate === '/dev/null') {
        currentFile = null;
        newLine = null;
      } else if (candidate.startsWith('b/')) {
        currentFile = candidate.slice(2);
        if (!map.has(currentFile)) {
          map.set(currentFile, new Set());
        }
      }
      continue;
    }

    if (line.startsWith('@@ ')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (match) {
        newLine = Number(match[1]);
      }
      continue;
    }

    if (!currentFile || newLine === null) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      map.get(currentFile).add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }

    newLine += 1;
  }

  return map;
}

export function partitionFindingsByDiffEligibility(findings, diffText) {
  const changedLineMap = parseDiffChangedLineMap(diffText);
  const accepted = [];
  const rejected = [];

  for (const finding of findings) {
    const changedLines = changedLineMap.get(finding.path);

    if (!changedLines) {
      rejected.push({ finding, reason: 'path-not-in-diff' });
      continue;
    }

    let allLinesChanged = true;
    for (let line = finding.line; line <= finding.end_line; line += 1) {
      if (!changedLines.has(line)) {
        allLinesChanged = false;
        break;
      }
    }

    if (!allLinesChanged) {
      rejected.push({ finding, reason: 'line-not-in-added-lines' });
      continue;
    }

    accepted.push(finding);
  }

  return { accepted, rejected };
}

export function sortFindingsBySeverity(findings) {
  return [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

export function buildInlineCommentBody(finding) {
  const lines = [
    `**[${finding.severity.toUpperCase()}] ${finding.title}**`,
    '',
    finding.body,
  ];

  if (finding.suggested_fix) {
    lines.push('', `**Suggested fix:** ${finding.suggested_fix}`);
  }

  return lines.join('\n');
}

export function buildHumanSummary(summary, findings) {
  if (!findings.length) {
    return 'No issues found.';
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  const topFindings = sortFindingsBySeverity(findings).slice(0, 10);

  const lines = [
    summary && summary.trim() ? summary.trim() : 'High-signal issues were found in this pull request.',
    '',
    `- High: ${counts.high}`,
    `- Medium: ${counts.medium}`,
    `- Low: ${counts.low}`,
    `- Total: ${findings.length}`,
    '',
    'Top findings:',
  ];

  for (const finding of topFindings) {
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.path}:${finding.line} - ${finding.title}`);
  }

  if (findings.length > topFindings.length) {
    lines.push(`- ...and ${findings.length - topFindings.length} more.`);
  }

  return lines.join('\n');
}

export function shouldFailBySeverity(findings, threshold) {
  if (!threshold || !Object.hasOwn(SEVERITY_RANK, threshold)) {
    return false;
  }

  const minRank = SEVERITY_RANK[threshold];
  return findings.some((finding) => SEVERITY_RANK[finding.severity] >= minRank);
}

export function getSeverityRank(severity) {
  return SEVERITY_RANK[severity] ?? 0;
}