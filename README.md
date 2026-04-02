# github-actions

Reusable GitHub Actions assets for Lagun271 repositories.

## Composite action: `actions/openai-pr-review`

This action:
- builds a PR diff
- requests review text from OpenAI Responses API
- submits a formal GitHub PR review via `pulls.createReview`

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
          review_event: REQUEST_CHANGES
          input_token_price_per_1m_usd: "0"
          output_token_price_per_1m_usd: "0"
```

Notes:
- `review_event: REQUEST_CHANGES` creates a formal “changes requested” review.
- Exact billed amount is not returned by the API in this action. The action reports token usage and can show an estimated cost when price inputs are configured.

