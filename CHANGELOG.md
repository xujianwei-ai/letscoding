# Changelog

## [1.0.0] - 2026-11-24

### Added

- **Graceful Stop**: Cancel active turns via `session/cancel` RPC without killing the Host process; partial streaming output is preserved as `interrupted` and the turn closes with `turn/end reason=aborted`
- **Warm Session Resume**: Host processes stay warm between turns, eliminating cold-start delays (~1800ms → ~170ms)
- **Submission Echo State Machine**: Webview tracks prompt submissions through `pending → accepted/observed/failed` states, replacing fragile DOM heuristics for stop recovery
- **Cancel Integration Tests**: `cancel-integration-suite.cjs` for real VS Code end-to-end validation and `cancel-probe.ts` for minimal model-free probing

### Changed

- Rebranded from Private Coding Agent to **LetsCoding**
- Version bumped to 1.0.0
- `publisher` set to `xujianwei`
- `LICENSE` copyright updated to 许建伟

### Fixed

- Stop no longer rewinds user messages or deletes historical bubbles
- Interrupted streaming responses remain durable in session logs
- Follow-up prompts after stop start immediately without Host restart

[1.0.0]: https://github.com/xujianwei-ai/letscoding/releases/tag/v1.0.0
