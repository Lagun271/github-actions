import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  buildHumanSummary,
  buildInlineCommentBody,
  parseModelReview,
  partitionFindingsByDiffEligibility,
  shouldFailBySeverity,
  sortFindingsBySeverity,
} from './review-core.js';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalEnv(name, defaultValue = '') {
  const value = process.env[name];
  return value === undefined ? defaultValue : value;
}

function envBool(name, defaultValue = false) {
  const value = optionalEnv(name, '').trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function sanitizeEvent(reviewEvent) {
  const upper = (reviewEvent || 'COMMENT').toUpperCase();
  return ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'].includes(upper) ? upper : 'COMMENT';
}

function apiHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function githubRequest(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${text.slice(0, 1200)}`);
  }
  return response;
}

function readOpenAiOutputText(responseJson) {
  const candidates = [];

  if (typeof responseJson.output_text === 'string' && responseJson.output_text.trim()) {
    candidates.push(responseJson.output_text);
  }

  for (const output of responseJson.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === 'string' && content.text.trim()) {
        candidates.push(content.text);
      }
    }
  }

  for (const choice of responseJson.choices || []) {
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      candidates.push(content);
    }
  }

  return candidates.join('\n\n').trim();
}

async function loadSystemPrompt() {
  const defaultPromptPath = requiredEnv('DEFAULT_PROMPT_PATH');
  if (!existsSync(defaultPromptPath)) {
    throw new Error(`Default prompt file not found: ${defaultPromptPath}`);
  }

  const defaultPrompt = await readFile(defaultPromptPath, 'utf8');
  const customPromptPath = optionalEnv('PROMPT_FILE', '').trim();

  if (!customPromptPath) {
    return defaultPrompt;
  }

  if (!existsSync(customPromptPath)) {
    throw new Error(`prompt_file not found: ${customPromptPath}`);
  }

  const customPrompt = await readFile(customPromptPath, 'utf8');
  return `${defaultPrompt}\n\nAdditional repository-specific instructions:\n${customPrompt}`;
}

async function requestOpenAiReview(model, systemPrompt, diffText, openAiApiKey) {
  const payload = {
    model,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Review this pull request diff:\n\n${diffText}` },
    ],
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseJson = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = responseJson?.error?.message || `OpenAI request failed with status ${response.status}.`;
    throw new Error(message);
  }

  const outputText = readOpenAiOutputText(responseJson);
  if (!outputText) {
    throw new Error('OpenAI response did not contain any text output.');
  }

  return {
    outputText,
    usage: {
      input_tokens: Number(responseJson?.usage?.input_tokens ?? responseJson?.usage?.prompt_tokens ?? 0),
      output_tokens: Number(responseJson?.usage?.output_tokens ?? responseJson?.usage?.completion_tokens ?? 0),
      total_tokens: Number(responseJson?.usage?.total_tokens ?? 0),
    },
  };
}

async function loadReviewFromFixture(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`OPENAI_RESPONSE_FILE not found: ${filePath}`);
  }

  const outputText = await readFile(filePath, 'utf8');
  return {
    outputText,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

function buildReviewHeader(usage) {
  const generatedAtUtc = new Date().toISOString();
  const serverUrl = optionalEnv('GITHUB_SERVER_URL', 'https://github.com');
  const repo = optionalEnv('GITHUB_REPOSITORY', 'local/repo');
  const runId = optionalEnv('GITHUB_RUN_ID', 'local');
  const runUrl = `${serverUrl}/${repo}/actions/runs/${runId}`;

  return [
    '## OpenAI API PR Review',
    `_Generated: ${generatedAtUtc} (UTC) · [Run](${runUrl})_`,
    `_Usage: input=${usage.input_tokens}, output=${usage.output_tokens}, total=${usage.total_tokens}_`,
    '',
  ].join('\n');
}

async function getPrHeadSha({ owner, repo, prNumber, githubToken, githubApiBaseUrl }) {
  const response = await githubRequest(`${githubApiBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: 'GET',
    headers: apiHeaders(githubToken, { 'X-GitHub-Api-Version': '2022-11-28' }),
  });

  const pr = await response.json();
  return pr?.head?.sha;
}

async function createTopLevelReview({ owner, repo, prNumber, githubToken, githubApiBaseUrl, body, event }) {
  await githubRequest(`${githubApiBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    headers: apiHeaders(githubToken, { 'X-GitHub-Api-Version': '2022-11-28' }),
    body: JSON.stringify({ body, event }),
  });
}

function createInlinePayload({ commitSha, finding }) {
  const payload = {
    body: buildInlineCommentBody(finding),
    commit_id: commitSha,
    path: finding.path,
    line: finding.end_line,
    side: 'RIGHT',
  };

  if (finding.end_line > finding.line) {
    payload.start_line = finding.line;
    payload.start_side = 'RIGHT';
  }

  return payload;
}

async function createInlineComment({ owner, repo, prNumber, githubToken, githubApiBaseUrl, payload }) {
  await githubRequest(`${githubApiBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
    method: 'POST',
    headers: apiHeaders(githubToken, { 'X-GitHub-Api-Version': '2022-11-28' }),
    body: JSON.stringify(payload),
  });
}

async function main() {
  const dryRun = envBool('DRY_RUN', false);
  const model = optionalEnv('MODEL', 'gpt-5-mini');
  const reviewEvent = sanitizeEvent(optionalEnv('REVIEW_EVENT', 'COMMENT'));
  const failOnSeverity = optionalEnv('FAIL_ON_SEVERITY', '').trim().toLowerCase();

  const diffText = await readFile('pr.diff', 'utf8');
  const systemPrompt = await loadSystemPrompt();

  let openAiResult;
  const responseFixtureFile = optionalEnv('OPENAI_RESPONSE_FILE', '').trim();
  if (responseFixtureFile) {
    openAiResult = await loadReviewFromFixture(responseFixtureFile);
  } else {
    const openAiApiKey = requiredEnv('OPENAI_API_KEY');
    openAiResult = await requestOpenAiReview(model, systemPrompt, diffText, openAiApiKey);
  }

  await writeFile('openai-response.txt', openAiResult.outputText, 'utf8');
  await writeFile('effective-system-prompt.md', systemPrompt, 'utf8');

  const parsedReview = parseModelReview(openAiResult.outputText);
  const sortedFindings = sortFindingsBySeverity(parsedReview.findings);
  const eligibility = partitionFindingsByDiffEligibility(sortedFindings, diffText);

  const bodyParts = [
    buildReviewHeader(openAiResult.usage),
    buildHumanSummary(parsedReview.summary, sortedFindings),
  ];
  const reviewBody = bodyParts.join('\n');

  let postedInline = 0;
  let rejectedInline = eligibility.rejected.length;

  if (dryRun) {
    const preview = {
      dry_run: true,
      model,
      review_event: reviewEvent,
      findings_total: sortedFindings.length,
      findings_eligible_for_inline: eligibility.accepted.length,
      findings_rejected_for_inline: rejectedInline,
      rejected_findings: eligibility.rejected,
      review_body: reviewBody,
      inline_payloads: eligibility.accepted.map((finding) => createInlinePayload({ commitSha: 'dry-run-sha', finding })),
    };

    const outputFile = optionalEnv('DRY_RUN_OUTPUT_FILE', 'dry-run-report.json');
    await writeFile(outputFile, `${JSON.stringify(preview, null, 2)}\n`, 'utf8');
    console.log(`Dry run complete. Wrote preview to ${outputFile}`);
  } else {
    const githubToken = requiredEnv('GITHUB_TOKEN');
    const githubRepository = requiredEnv('GITHUB_REPOSITORY');
    const [owner, repo] = githubRepository.split('/');
    const prNumber = Number(requiredEnv('PR_NUMBER'));
    const githubApiBaseUrl = optionalEnv('GITHUB_API_URL', 'https://api.github.com');

    await createTopLevelReview({
      owner,
      repo,
      prNumber,
      githubToken,
      githubApiBaseUrl,
      body: reviewBody,
      event: reviewEvent,
    });

    if (eligibility.accepted.length > 0) {
      const headSha = await getPrHeadSha({ owner, repo, prNumber, githubToken, githubApiBaseUrl });
      if (!headSha) {
        throw new Error('Could not resolve PR head SHA for inline comments.');
      }

      const maxInlineComments = 40;
      for (const finding of eligibility.accepted.slice(0, maxInlineComments)) {
        const payload = createInlinePayload({ commitSha: headSha, finding });
        try {
          await createInlineComment({ owner, repo, prNumber, githubToken, githubApiBaseUrl, payload });
          postedInline += 1;
        } catch (error) {
          rejectedInline += 1;
          console.warn(`Inline comment rejected for ${finding.path}:${finding.line}: ${error.message}`);
        }
      }
    }

    console.log(`Posted top-level review. Findings: ${sortedFindings.length}, inline posted: ${postedInline}, inline rejected: ${rejectedInline}`);
  }

  if (shouldFailBySeverity(sortedFindings, failOnSeverity)) {
    throw new Error(`Found issue(s) at or above fail-on-severity=${failOnSeverity}.`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});