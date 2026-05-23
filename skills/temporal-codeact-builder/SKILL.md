---
name: temporal-codeact-builder
description: Build a Python Temporal scaffold through Pi's CodeAct-style bash path for the Temporal case-study ReAct vs CodeAct demo.
---

# Temporal CodeAct Builder

Use this skill when the user wants a Pi + Temporal demo that goes beyond planning and creates runnable Temporal code artifacts.

## Workflow

1. Explain the agent ladder briefly:
   - simple agent: answers directly from the prompt
   - Reason + Act agent: sequentially discovers, fetches, and extracts Temporal customer-story pages
   - CodeAct agent: uses `bash` to write and validate case-study-research-aligned Python Temporal scaffold files at runtime
2. Tie the demo to one business scenario: use `free_web_search` and `free_fetch_content` to search Temporal's live website for customer case studies, extract proof points, and generate approval-gated marketing HTML.
3. Prefer the CodeAct path for the main demo artifact.
4. Use `bash` from the example package root:

```bash
npm run harness-demo -- --agent codeact
```

5. Inspect the generated report and scaffold under `artifacts/harness-runs/<run-id>/`.
6. Keep the demo local. Do not start external workflows, send email, or call production systems unless the user explicitly asks.

## Output Expectations

Summarize:
- which Temporal primitives were generated
- how the Temporal case-study research and marketing HTML scenario is covered
- where the scaffold files were written
- how the CodeAct bash path differs from the simple and Reason + Act paths
