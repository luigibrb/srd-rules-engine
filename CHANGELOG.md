# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/); until 1.0, minor versions may contain breaking changes.

## [Unreleased]

### Changed
- Ported the engine from Python (FastAPI, Pydantic) to TypeScript. Saved builds keep the
  same JSON format, so characters saved by the Python builder still load.
- The HTTP API is now a framework-free `fetch` handler (`srd-rules-engine/http`) that runs on
  Node, Deno, Bun and Cloudflare Workers. Routes and payloads are unchanged.
- `/v1/spells/save` also returns `damage_dealt`.
- Dice expressions are limited to 1000 dice of up to 1000 sides.

### Added
- Content packs: `createCatalog(srdPack, homebrewPack)` layers homebrew over the SRD.
- `srd-rules validate <dir>` checks a content pack.
- JSON Schemas for every content file and for saved builds (`schemas/`).
- The SRD as one JSON file: `srd-rules-engine/srd-5.2.1.json`.
- HTTP: `GET /v1/content/...` and `POST /v1/builds/evaluate`.
- `seededRng`, `scriptedRng` and `fixedRng` for deterministic dice.
