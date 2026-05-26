---
name: temporal-developer
description: Generate, debug, and manage Temporal applications with the Temporal SDK, especially Python workflows, activities, workers, clients, signals, queries, retries, determinism, and durable AI-agent patterns.
version: 0.4.0-local
source: https://github.com/temporalio/skill-temporal-developer
---

# Temporal Developer Agent Skill

Use this skill when generating or reviewing Temporal application code. For this demo, use the Python SDK guidance to generate runnable workflow, activity, worker, and client files for the CodeAct case-study research scaffold.

## Python Code Generation Rules

1. Keep Workflow definitions separate from Activity implementations. Workflow files should stay focused on deterministic orchestration; Activities own network calls, filesystem work, subprocess calls, and other side effects.
2. Use `@workflow.defn` on Workflow classes and `@workflow.run` on the entry point. Use `@workflow.signal` for external approval/pause inputs and `@workflow.query` for read-only state inspection.
3. Import Activity functions into Workflow files inside `with workflow.unsafe.imports_passed_through():` so Activity dependencies do not pollute the workflow sandbox.
4. Default external I/O to sync Activities when using blocking libraries, and register a `ThreadPoolExecutor` as the Worker `activity_executor`.
5. Use `workflow.execute_activity(...)` with timeouts and a `RetryPolicy` when the operation can fail transiently. Mark permanent Activity failures with `ApplicationError(..., non_retryable=True)`.
6. Use deterministic workflow APIs instead of nondeterministic runtime calls. Put direct I/O, threading, sleeps, subprocesses, random values, and wall-clock reads in Activities or use Temporal-provided workflow alternatives.
7. For parallel activity work, create bounded batches and await them with `asyncio.gather(..., return_exceptions=True)` when partial failure should not lose successful results.
8. Keep Queries read-only. Signal and Update handlers must not accidentally let the Workflow complete before pending async handlers finish.
9. Disable retries in nested API clients when Temporal owns retries for the Activity.
10. Test Workflows with mocked Activities and explicitly cover Signal and Query behavior.

## References

The guidance above is a local, demo-scoped summary of Temporal's `temporal-developer` Agent Skill and its Python references:

- https://github.com/temporalio/skill-temporal-developer/blob/main/SKILL.md
- https://github.com/temporalio/skill-temporal-developer/tree/main/references/python
- https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/python.md
- https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/determinism.md
- https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/patterns.md
- https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/error-handling.md
- https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/ai-patterns.md
- https://github.com/temporalio/skill-temporal-developer/blob/main/references/python/testing.md
