---
name: temporal-case-study-marketing-page
description: Research Temporal-owned customer case-study pages, extract customer-proof data, and draft cited marketing HTML for the Pi + Temporal ReAct vs CodeAct demo.
---

# Temporal Case-Study Marketing Page

Use this skill when the user wants the Pi + Temporal demo centered on live Temporal customer stories and side-by-side ReAct vs CodeAct artifacts.

## Workflow

1. Use `free_web_search` and `free_fetch_content` for live discovery and page reading.
2. Treat `https://temporal.io/in-use` as the starting page.
3. Count only Temporal-owned URLs under `https://temporal.io/resources/case-studies/` as valid case-study sources.
4. Extract only observable facts:
   - company name
   - headline
   - customer-proof summary
   - evidence quote
   - Temporal value statement
   - source URL
5. If fewer than 20 valid records are found, preserve the partial result and mark the output as needing review.
6. Produce draft-only marketing collateral:
   - customer-proof matrix
   - coverage-gap notes
   - complete HTML page
   - source citations
   - approval gate

## ReAct Mode

Show a sequential loop:

1. Reason about the next page to fetch.
2. Fetch one page.
3. Extract one record.
4. Observe the result.
5. Stop when the page budget is exhausted, 20 records are found, or a reviewer pauses.

## CodeAct Mode

Use the bash escape hatch when asked to showcase CodeAct:

```bash
temporal scaffold business-use-cases
temporal scaffold primitives
temporal scaffold write
temporal scaffold validate
temporal case-study extract --mode codeact
```

The generated scaffold should be Python and include Temporal Workflow, Activities, Signals, Queries, RetryPolicy, worker, client, and bounded parallel activity execution.

## Guardrails

- Do not invent missing case studies, customer metrics, quotes, or claims.
- Do not scrape personal contact data.
- Do not publish, send email, update CRM, or claim external action was taken.
- Do not reveal environment variables, API keys, Temporal namespace, `PI_COMMAND`, or raw command secrets.
- Cite source URLs for every extracted customer proof point.
