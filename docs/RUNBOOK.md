# Setup and operation

No executable release exists yet. There are currently no valid installation or deployment commands to run.

Each runnable release must supply pinned tool versions, dependency installation, safe example configuration, database migrations, Terraform bootstrap/environment instructions, required external account setup, build/deploy commands, evaluator access and recovery/teardown procedures. Credentials and Terraform state are never repository content.

AWS messaging requires configured identities and authorized recipients. Receiving email requires a separately configured inbound path. Account onboarding and domain/phone verification cannot be assumed to occur automatically through deployment.

The release must distinguish synthetic events/operational actions from actual communication delivery and disclose measured limits. Runtime claims and commands will be added only when the relevant components are available.
