# Repository Guidelines

## Project Structure & Module Organization

Auto-PM-Lite is a TypeScript control plane for supervising Claude and Codex runtimes. Runtime-independent contracts live in `src/core/`. Orchestration logic is in `src/orchestrator/`, persistence in `src/storage/`, runtime adapters in `src/runtime/`, and MCP integration in `src/mcp/`. The CLI entrypoint is `src/index.ts`, with app wiring in `src/app.ts`.

Tests mirror subsystem boundaries under `tests/`, for example `tests/orchestrator/`, `tests/mcp/`, and `tests/security/`. Live SDK probes and smoke scripts live in `spikes/`; keep these focused and safe to run manually.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies. Node `>=22` is required.
- `pnpm run dev`: run the CLI directly through `tsx src/index.ts`.
- `pnpm run typecheck`: run TypeScript without emitting files.
- `pnpm test`: run the Vitest suite once.
- `pnpm run build`: bundle ESM output and declarations with `tsup`.
- `pnpm run test:live`: run real Claude/Codex smoke checks; requires configured credentials or local wrappers.

## Coding Style & Naming Conventions

Use strict TypeScript with ESM imports and explicit exported types for public surfaces. Keep files ASCII unless a file already requires Unicode. Prefer small modules grouped by subsystem. Use camelCase for variables/functions, PascalCase for classes/interfaces, and kebab-case only for CLI command names. Avoid adding abstractions unless they reduce real duplication or clarify runtime boundaries.

## Testing Guidelines

Vitest is the test framework. Name tests `*.spec.ts` and place them under the matching `tests/<subsystem>/` directory. Add focused unit tests for policy, storage, normalization, delegation, and redaction changes. Runtime changes should pass `pnpm run typecheck`, `pnpm test`, and `pnpm run build`; use `pnpm run test:live` only when credentials and network access are available.

## Commit & Pull Request Guidelines

Existing commits use short imperative summaries, such as `Implement Phase 3 dual-surface MCP delegation.` Follow that style: one clear sentence, capitalized, ending with a period. PRs should describe behavior changes, list verification commands, call out live-smoke limitations, and mention any schema/config changes.

## Security & Configuration Tips

Never store raw API keys in profiles, tasks, events, logs, or fixtures. Use `secretRef` values such as `env:OPENAI_API_KEY`. Keep live smoke output redacted and avoid committing local DB files, logs, `dist/`, or `node_modules/`.
