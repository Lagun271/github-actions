# github-actions

Reusable GitHub Actions assets for Lagun271 repositories.

## Composite action: `actions/openai-pr-review`

This action now:
- builds a PR diff
- sends diff + strict review prompt to OpenAI Responses API
- parses structured JSON findings
- posts a human-readable top-level PR review summary
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
- The default system prompt is in `actions/openai-pr-review/default-system-prompt.md`.
- The model must return strict JSON so findings can be converted into inline PR comments.