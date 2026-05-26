# Pi + Temporal ReAct vs CodeAct Demo

Open-source demo showing how to wrap LLM-driven research in a durable, inspectable Temporal workflow.

The demo researches Temporal-owned customer case-study pages, then compares two agent execution styles:

- **ReAct**: Pi/LLM chooses the live-search branches and bounded concurrency while the harness uses the same target/page budget as CodeAct, then extracts evidence from selected pages.
- **CodeAct**: Pi/LLM generates Python Temporal workflow code, the harness validates it, and the generated workflow can run in Temporal Cloud.

Both paths produce draft-only marketing artifacts with citations and an explicit approval gate. The demo does not publish pages, send email, update CRM, or call external business systems.

## Contents

- `src/` - TypeScript Temporal workflow, activities, CLI commands, web UI, and agent harness code.
- `skills/` - Pi skills used for customer-story research, Temporal Agent Skill-backed CodeAct scaffold generation, and demo narrative generation.
- `.pi/free-web-search.json` - Pi free-web-search tool configuration.
- `test/` - Unit and harness tests for extraction, policy, redaction, and CodeAct validation.
- `artifacts/.gitignore` - placeholder for generated local output.
- `.env.example` - local configuration template with placeholder values only.

Generated artifacts, installed dependencies, and personal `.env` files are intentionally excluded from version control.

## Prerequisites

- Node.js 22 or newer and npm.
- Python 3 available as `python3` for CodeAct scaffold validation.
- Internet access for live discovery from `temporal.io`.
- An Anthropic API key for live Pi/LLM generation.
- Temporal Cloud credentials for the full durable workflow demo.

When a generated Python Temporal workflow is run, the harness creates a local Python virtual environment if needed.

## Quick Start

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- Set `ANTHROPIC_API_KEY`.
- Keep `PI_COMMAND="pi --provider anthropic --model claude-sonnet-4-5"` unless you are using another Pi provider/model.
- For the full Temporal Cloud demo, set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, and `TEMPORAL_TASK_QUEUE`.
- Set `CODEACT_TEMPORAL_CLOUD=0` if you want harness-only runs without starting generated Python workflows in Temporal Cloud.

Check Pi/LLM generation:

```bash
npm run check-pi
```

Check Temporal Cloud configuration:

```bash
npm run check-env
```

`npm run check-pi` performs a small real generation, not only `pi --help`. If it reports an OAuth/PAT token error, unset `ANTHROPIC_OAUTH_TOKEN`, keep `ANTHROPIC_API_KEY` set to a standard Anthropic API key, then retry.

## Run Modes

Full Temporal Cloud web demo:

```bash
npm run cloud
```

Then open the URL printed by the web server, usually `http://localhost:8787`.

Harness-only comparison:

```bash
npm run harness-demo -- --agent all
```

CodeAct-only harness run:

```bash
npm run harness-demo -- --agent codeact
```

To move CodeAct scaffold validation and repair into Temporal history, set
`CODEACT_SCAFFOLD_CHILD_WORKFLOW=1` and run through `npm run cloud` so the
TypeScript worker can execute the parent and child workflows. The harness keeps
the local validate/repair loop as the fallback when the child workflow path is
disabled or unavailable.

Manual Temporal run:

```bash
npm run worker
npm run web
npm run demo -- --scenario temporal-case-study-marketing-page
npm run approve -- --workflow <workflow-id> --decision approved
```

Offline parser/export smoke test:

```bash
npm run dry-run -- --scenario temporal-case-study-marketing-page
```

## Outputs

Generated output is written under `artifacts/`, which is ignored by git.

Expected harness outputs:

- `artifacts/harness-runs/<run-id>/react/react-case-study-page.html`
- `artifacts/harness-runs/<run-id>/codeact/codeact-case-study-page.html`
- `artifacts/harness-runs/<run-id>/react-vs-codeact-comparison.md`
- `artifacts/harness-runs/<run-id>/codeact/runtime-temporal-scaffold/`

## Safety Model

- Only Temporal-owned URLs under `/resources/case-studies/` count as customer proof.
- Every generated proof point must carry a source URL.
- If fewer than the target number of valid stories are found, the run is marked `needs_review`; missing stories are not fabricated.
- CLI checks, web UI status, worker logs, and harness output redact API keys, Temporal namespace/address, task queues, Anthropic keys, and `PI_COMMAND`.
- The generated artifacts are drafts only.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run check
```

`npm run check` runs lint, TypeScript type checking, and the full test suite.

## Troubleshooting

- **Placeholder Temporal values**: `npm run check-env` reports `placeholder` when `.env.example` values have not been replaced.
- **No Temporal Cloud account**: set `CODEACT_TEMPORAL_CLOUD=0` and use `npm run harness-demo -- --agent all`.
- **Pi command not found**: install the Pi CLI or set `PI_COMMAND` to the command you use locally.
- **Generated Python workflow cannot start**: run `npm run harness-demo -- --agent codeact` first. The harness still validates generated code and falls back to local extraction when cloud execution is disabled or unavailable.

## Contributing

See `CONTRIBUTING.md` for development setup, validation expectations, and pull request guidance.

## License

This project is licensed under the MIT License. See `LICENSE`.

See `TEMPORAL_SKILL_CITATIONS.md` for the Temporal Agent Skill, Python references, and source-citation policy used by the generated CodeAct scaffold.
