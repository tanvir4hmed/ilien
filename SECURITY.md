# Security

ILIEN is a demonstration system. Do not use real customer records, credentials, or production contact details in its synthetic examples.

The runtime uses IAM-scoped workloads, a private encrypted Aurora cluster, encrypted S3 evidence storage, Secrets Manager, API authentication, and server-side membership checks. Original source content, inbound messages, provider events, and case actions are retained separately so a later interpretation cannot overwrite their provenance.

Do not report secrets or sensitive vulnerability details in public issues. Use a private reporting channel agreed by the repository owner. Before production use, establish a customer-specific vulnerability contact, operator identity policy, retention/deletion process, incident notification destination, and independent security review.

Provider delivery and participant identity are not equivalent to business authorization. Treat blocked or uncertain delivery as unresolved until supported by provider evidence and an authorized case action.
