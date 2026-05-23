# Contributing

Thanks for improving this demo. Keep changes focused on making the Temporal, Pi, ReAct, and CodeAct behavior easier to understand, run, or verify.

## Development Setup

```bash
npm install
cp .env.example .env
```

Use placeholder-free local values in `.env`. Do not commit `.env`, generated artifacts, dependency folders, or credentials.

## Validation

Before opening a pull request, run:

```bash
npm run check
```

For changes that affect live generation or Temporal Cloud behavior, also run the relevant mode:

```bash
npm run check-pi
npm run harness-demo -- --agent all
npm run cloud
```

`npm run cloud` requires real Temporal Cloud credentials.

## Pull Request Guidelines

- Keep generated files under `artifacts/`; they should not be committed.
- Include tests for parser, policy, redaction, scaffold validation, or harness behavior when those surfaces change.
- Preserve the safety model: cite source URLs, redact secrets, avoid fabricated customer stories, and keep external business actions draft-only.
- Update `README.md` when setup, run modes, configuration, or expected outputs change.

## Reporting Bugs

Include:

- Node.js and npm versions.
- Command that failed.
- Whether `CODEACT_TEMPORAL_CLOUD` was `0` or `1`.
- Redacted logs or test output.

Never include API keys, Temporal namespace/address, task queues, or raw `PI_COMMAND` values.
