# github-actions

Reusable GitHub Actions for automated OpenAI-powered PR reviews.

## Composite action: `actions/openai-pr-review`

This action:
- builds a PR diff against the base branch
- sends the diff to the OpenAI Responses API and extracts the review text
- posts the result as a formal GitHub PR review, appearing in the PR's Reviews section with COMMENT, REQUEST_CHANGES, or APPROVE status

The review is a single top-level comment — there are no inline annotations on individual lines.

### Usage

```yaml
name: OpenAI PR Review

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

      - uses: Lagun271/github-actions/actions/openai-pr-review@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pr_number: ${{ github.event.pull_request.number }}
          base_ref: ${{ github.event.pull_request.base.ref }}
```

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `openai_api_key` | yes | — | OpenAI API key |
| `github_token` | yes | — | GitHub token with `pull-requests: write` |
| `pr_number` | yes | — | Pull request number |
| `base_ref` | yes | — | Base branch used to build the diff |
| `model` | no | `gpt-5-mini` | OpenAI model name |
| `max_diff_chars` | no | `120000` | Max diff characters sent to OpenAI |
| `review_event` | no | `COMMENT` | Review event type: `COMMENT`, `REQUEST_CHANGES`, or `APPROVE` |

### GitHub token options

**`GITHUB_TOKEN`** — simplest, works out of the box for single-repo use:

```yaml
github_token: ${{ secrets.GITHUB_TOKEN }}
```

**GitHub App** — recommended for cross-repo use. Create a GitHub App with `pull-requests: write`, install it on the target repos, then generate an installation token as a pre-step:

```yaml
steps:
  - uses: actions/create-github-app-token@v1
    id: app-token
    with:
      app-id: ${{ vars.APP_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}

  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  - uses: Lagun271/github-actions/actions/openai-pr-review@v1
    with:
      openai_api_key: ${{ secrets.OPENAI_API_KEY }}
      github_token: ${{ steps.app-token.outputs.token }}
      pr_number: ${{ github.event.pull_request.number }}
      base_ref: ${{ github.event.pull_request.base.ref }}
```

**PAT** — store a personal access token with `pull-requests: write` as a secret and pass it directly.

### Notes

- Set `review_event: REQUEST_CHANGES` to post a formal "changes requested" review.
- Token usage (input, output, total) is always reported in the review body.
- The OpenAI Responses API (`/v1/responses`) is used. The action also handles Chat Completions response shapes for compatibility.

## Reusable workflow: `.github/workflows/openai-pr-review.yml`

A `workflow_call` wrapper around the composite action, for use within the same GitHub org without referencing the composite action directly.

```yaml
jobs:
  review:
    uses: Lagun271/github-actions/.github/workflows/openai-pr-review.yml@v1
    with:
      pr_number: ${{ github.event.pull_request.number }}
      base_ref: ${{ github.event.pull_request.base.ref }}
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## License

[MIT](LICENSE)
