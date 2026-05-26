# Temporal Skill Citations

This demo uses the Temporal Agent Skill for CodeAct scaffold generation. The scaffold-generation and repair calls in `src/harness/pi-harness.ts` pass `--skill skills/temporal-developer/SKILL.md` to Pi, then ask Pi to emit the bash heredoc scaffold for the Temporal customer case-study workflow.

The harness prompt still supplies the demo-specific output contract: required files, heredoc format, case-study crawling constraints, Cloud environment variables, and strict validation gates. The Temporal Agent Skill supplies the Temporal SDK code-generation guidance for Workflows, Activities, Workers, Clients, determinism, retries, Signals, Queries, and durable AI-agent patterns.

Selected files from Temporal's Python skill reference directory are used both as generation guidance and as the basis for post-generation validation checks. The demo keeps only a concise local summary under `skills/temporal-developer/SKILL.md` and links to the upstream sources instead of copying large snippets.

## Temporal Agent Skill

- `temporal-developer` skill: https://github.com/temporalio/skill-temporal-developer/blob/main/SKILL.md
- Python reference directory: https://github.com/temporalio/skill-temporal-developer/tree/main/references/python

## Temporal Python References Used

- `python.md`: https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/python.md
  - Used for workflow/activity/worker/client structure, file separation, `@workflow.defn`, `@activity.defn`, and sync activity guidance.
- `determinism.md`: https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/determinism.md
  - Used for the rule that workflow code stays deterministic and network/filesystem/subprocess work belongs in Activities.
- `patterns.md`: https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/patterns.md
  - Used for Signals, Queries, `workflow.wait_condition`, and bounded parallel activity execution.
- `error-handling.md`: https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/error-handling.md
  - Used for `ApplicationError`, retryable vs non-retryable activity failures, and `RetryPolicy`.
- `ai-patterns.md`: https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/ai-patterns.md
  - Used for the parallel research pattern, partial failure handling, and the principle that client retries should be disabled when Temporal owns retries.
- `testing.md`: https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/testing.md
  - Used for the test plan: mock activities/external fetches and test signal/query state without broad live crawling.

## Temporal Customer-Story Sources

The live demo starts at:

- https://temporal.io/in-use
- https://temporal.io/sitemap.xml

The generated per-run citation artifacts list the exact customer-story URLs extracted during that run. The default live crawl filters to Temporal-owned pages under:

- https://temporal.io/resources/case-studies/anz-story
- https://temporal.io/resources/case-studies/attentive-migrates-temporal-cloud-infra-cost-savings
- https://temporal.io/resources/case-studies/autokitteh
- https://temporal.io/resources/case-studies/box
- https://temporal.io/resources/case-studies/bugcrowd
- https://temporal.io/resources/case-studies/checkr
- https://temporal.io/resources/case-studies/coinbase
- https://temporal.io/resources/case-studies/dapperlabs-story
- https://temporal.io/resources/case-studies/descript
- https://temporal.io/resources/case-studies/digitalocean
- https://temporal.io/resources/case-studies/dubber
- https://temporal.io/resources/case-studies/duolingo-temporal-nexus
- https://temporal.io/resources/case-studies/emergent
- https://temporal.io/resources/case-studies/firehydrant
- https://temporal.io/resources/case-studies/gorgias-uses-ai-agents-to-improve-customer-service
- https://temporal.io/resources/case-studies/gradient-labs-uses-ai-agents-to-resolve-complex-customer-issues
- https://temporal.io/resources/case-studies/how-datadog-ensures-database-reliability-with-temporal
- https://temporal.io/resources/case-studies/how-retool-built-robust-workflow-agents-products
- https://temporal.io/resources/case-studies/how-vodafone-aims-to-orchestrate-value-added-services-across-devices
- https://temporal.io/resources/case-studies/instacart-simplifies-complex-workflows

If the live site changes, the workflow keeps partial extracted state and marks the result as needing review instead of fabricating missing records.
