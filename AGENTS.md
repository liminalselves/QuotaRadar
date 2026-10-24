# QuotaRadar

- Scope and amount semantics: `docs/design.md`; implementation gates: `docs/implementation.md`; progress: `NEXT.md`.
- Personal single-service app. Quota providers and message transports share one refresh service and SQLite state.
- Never put real API keys, bot tokens, account IDs or production responses in source, fixtures or logs. External calls need explicit authorization.
- SnowLuma stays a separate official container. Its v1.10.0 auth-file bootstrap and RFB 3.8 adapter are version-pinned; reverify both before changing versions. Bundled deployment authenticates only through QuotaRadar, never publishes driver ports or sends internal credentials to browsers. Bot logic uses OneBot only; never auto-accept driver agreements.
- Amounts are decimal strings, not binary floating-point. An unknown value is not zero; failed queries must not replace successful snapshots.
- Built-in Node SQLite requires Node >=22.13. Core tests run without npm dependencies: `npm test`.
- Deployment contract: server Compose must work with images and .env only, without source bind mounts or Node/npm on the host. Local builds use compose.build.yaml; driver startup assets ship in the application image.
- New dependencies require user permission. Keep actual verification and external-service verification separate in `NEXT.md`.
