# Synthetic event catalogue

`catalog.json` lists 231 event names in 35 vocabulary groups. Each fixture is an independently authored, editable envelope with a minimal illustrative payload. Payloads are **synthetic and unverified**, not production application exports. All entries currently enter explicit `triage`; workflow support is false until the relevant coordination implementation exists.

Use `npm run simulate -- packages/simulation/fixtures/<event>.json` with an authorized local AWS session and `ILIEN_API_URL`. The simulator signs requests using SigV4; tenant/source/origin come from server-side connection mapping. To create another event, copy a fixture, choose a new event ID and edit its payload. Retrying identical bytes reuses the original intake; changing bytes with the same event ID returns a conflict.

This phase provides a CLI simulator. Searchable browser console and role-play interactions are later deliverables. No fixture triggers external messages or operational actions.
