# Synthetic event catalogue

`catalog.json` lists 231 event names in 35 vocabulary groups. Each fixture is an independently authored, editable envelope with a minimal illustrative payload. Payloads are **synthetic and unverified**, not production application exports. The catalogue fixtures retain explicit `triage` because they carry an unverified synthetic payload version. Separate validated examples in `packages/contracts/examples/` activate the material-readiness and revision-acknowledgement workflows; vocabulary coverage is not workflow coverage.

Use `npm run simulate -- packages/simulation/fixtures/<event>.json` with an authorized local AWS session and `ILIEN_API_URL`. The simulator signs requests using SigV4; tenant/source/origin come from server-side connection mapping. To create another event, copy a fixture, choose a new event ID and edit its payload. Retrying identical bytes reuses the original intake; changing bytes with the same event ID returns a conflict.

This phase provides a CLI simulator. Authenticated role-play commands are available through `scripts/coordinate.mjs`; a searchable browser console is not implemented. No fixture triggers external messages or operational actions.
