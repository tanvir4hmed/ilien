# ILIEN contracts

This package defines the versioned source-event and coordination-result types used by the API, workers, and synthetic examples.

Source events are admitted through an authenticated source connection. The service retains original source content and its hash before mapping it to a coordination case. Requests cannot choose their own trusted tenant, actor authority, recipient, or result destination.

Contracts cover source intake, case requirements, evidence references, amendments, results, and acknowledgements. Case transitions remain versioned and idempotent: an identical retry returns the recorded result, while changed content under the same idempotency key conflicts.

Examples in `examples/` are synthetic test inputs, not customer records or proof of external delivery.
