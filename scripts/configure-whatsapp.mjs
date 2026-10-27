// Provider gap: the pinned Terraform AWS provider does not expose this operation.
// Terraform owns the SNS destination. This idempotent bridge never replaces another destination.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  SocialMessagingClient,
  GetLinkedWhatsAppBusinessAccountCommand,
  PutWhatsAppBusinessAccountEventDestinationsCommand,
} from "@aws-sdk/client-socialmessaging";
const client = new SocialMessagingClient({ maxAttempts: 3 });
const id = process.env.TF_VAR_whatsapp_waba_id;
if (!id) throw new Error("Missing configured WABA");
const topic = execFileSync(
  "terraform",
  ["-chdir=infra/project", "output", "-raw", "whatsapp_topic_arn"],
  { encoding: "utf8" },
).trim();
let account;
try {
  account = (
    await client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id }))
  ).account;
} catch (error) {
  if (error?.name !== "ResourceNotFoundException") throw error;
  const warning =
    "WhatsApp event destination was not configured: the configured WABA is not linked to this AWS account. Link the intended WABA and update its GitHub Actions variables before testing WhatsApp. Other ILIEN deployment steps may continue; WhatsApp is not ready.";
  console.warn(warning);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n> **WhatsApp setup pending:** ${warning}\n`);
  process.exit(0);
}
if (!account || account.registrationStatus !== "COMPLETE")
  throw new Error("WABA not ready");
const existing = account.eventDestinations ?? [];
if (
  existing.length &&
  (existing.length !== 1 || existing[0].eventDestinationArn !== topic)
)
  throw new Error(
    "Existing WABA destination differs; preserved without changes",
  );
if (!existing.length)
  await client.send(
    new PutWhatsAppBusinessAccountEventDestinationsCommand({
      id,
      eventDestinations: [{ eventDestinationArn: topic }],
    }),
  );
console.log("WhatsApp event destination configured; no message sent.");
