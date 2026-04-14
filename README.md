# github-actions

Reusable GitHub Actions assets for Lagun271 repositories.

## Composite action: `actions/openai-pr-review`

This action reviews a pull request diff with OpenAI and posts results back to GitHub.

### What this action produces (and where it appears)

When the action runs, it creates two types of PR feedback:

1. **Human-readable top-level review summary**
   - Posted as a normal GitHub PR review (conversation tab).
   - Includes summary text and usage metadata.

2. **Inline review comments on code**
   - Posted directly on changed lines in the PR **Files changed** view.
   - Only comments findings that can be anchored to changed lines in the diff.

### Core behavior

- builds a PR diff
- sends diff + review instructions to OpenAI Responses API
- parses structured JSON findings
- posts top-level human-readable PR review summary
- posts inline PR file comments for findings with `path` + `line`
- filters inline comments to changed lines in the diff
- optionally fails CI based on severity threshold

### Inputs

- `openai_api_key` (required)
- `github_token` (required)
- `pr_number` (required)
- `base_ref` (required)
- `model` (default `gpt-5-mini`)
- `max_diff_chars` (default `120000`)
- `prompt_file` (optional; appended to default prompt)
- `review_event` (`COMMENT`, `REQUEST_CHANGES`, `APPROVE`)
- `fail_on_severity` (optional: `high`, `medium`, `low`)

### Prompt behavior

- Default prompt is always loaded from:
  - `actions/openai-pr-review/default-system-prompt.md`
- If you pass `prompt_file`, that file is appended as **additional repository-specific instructions**.

Example custom prompt file in caller repo:

```txt
# .github/review-prompt.txt
Prioritize correctness and security over style.
Avoid duplicate findings.
Only flag issues with clear user impact.
```

And pass it in workflow `with`:

```yaml
prompt_file: .github/review-prompt.txt
```

### Caller workflow example (private cross-repo use)

```yaml
name: OpenAI API PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/checkout@v4
        with:
          repository: Lagun271/github-actions
          ref: v1
          token: ${{ secrets.LAGUN271_ACTIONS_TOKEN }}
          path: ./.github/_shared-actions

      - uses: ./.github/_shared-actions/actions/openai-pr-review
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pr_number: ${{ github.event.pull_request.number }}
          base_ref: ${{ github.event.pull_request.base.ref }}
          model: gpt-5-mini
          max_diff_chars: "120000"
          prompt_file: .github/review-prompt.txt
          review_event: REQUEST_CHANGES
          fail_on_severity: high
```

## Local testing (no workflow run required)

Pure logic tests are in:
- `actions/openai-pr-review/src/review-core.js`
- `actions/openai-pr-review/test/review-core.test.js`

Run tests locally:

```bash
node --test actions/openai-pr-review/test/*.test.js
```

## Local dry-run preview

You can preview exactly what top-level review + inline payloads would be generated without calling GitHub APIs:

1. Create a local `pr.diff` file (or copy one from CI).
2. Use fixture output from `actions/openai-pr-review/test/fixtures/openai-response.valid.json`.

```bash
DRY_RUN=1 \
OPENAI_RESPONSE_FILE=actions/openai-pr-review/test/fixtures/openai-response.valid.json \
DEFAULT_PROMPT_PATH=actions/openai-pr-review/default-system-prompt.md \
node actions/openai-pr-review/src/run-review.js
```

Dry-run output is written to `dry-run-report.json` by default (override with `DRY_RUN_OUTPUT_FILE`).

Notes:
- The model must return strict JSON so findings can be converted into inline PR comments.
