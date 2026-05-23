# Security Policy

This repository is a demo, but please treat credentials and generated artifacts carefully.

## Reporting A Vulnerability

Open a private security advisory if the hosting platform supports it, or contact the repository maintainers privately before filing a public issue.

Include a concise description, affected files or commands, and safe reproduction steps. Do not include live API keys, Temporal Cloud credentials, Anthropic keys, or unredacted environment values.

## Credential Handling

- Store local credentials only in `.env`.
- Do not commit `.env`, generated artifacts, logs, virtual environments, or dependency folders.
- The application redacts known Temporal, Anthropic, and Pi command values from logs and UI output.
- Generated Python scaffolds read runtime credentials from environment variables; they should not write credentials into generated source files.

## Supported Version

This demo is maintained from the default branch. Please test security fixes with:

```bash
npm run check
```
