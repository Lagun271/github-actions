# github-actions

Reusable GitHub Actions workflows for Lagun271 repositories.

## Reusable workflow: OpenAI PR review

Workflow path:

- `.github/workflows/openai-pr-review.yml`

Example usage from a caller repository:

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
    uses: Lagun271/github-actions/.github/workflows/openai-pr-review.yml@v1
    with:
      pr_number: ${{ github.event.pull_request.number }}
      base_ref: ${{ github.event.pull_request.base.ref }}
      model: gpt-5-mini
      max_diff_chars: 120000
      review_event: COMMENT
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```
