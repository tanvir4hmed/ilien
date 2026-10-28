# Synthetic event catalogue

`catalog.json` and `fixtures/` provide synthetic event names and sample payloads for local and demonstration use. They are not customer exports and do not send external messages by themselves.

With an authorized configured source and `ILIEN_API_URL`, run:

```sh
npm run simulate -- packages/simulation/fixtures/<event>.json
```

The simulator signs the request with AWS SigV4. Identical event bytes are idempotent; changed bytes under the same source event ID are rejected as a conflict.
