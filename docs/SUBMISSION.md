# AWS CDS Agentic AI Partner Hackathon submission

## Project summary

**Name:** ILIEN — Evidence-Preserving Textile Coordination
**Tagline:** Omnichannel coordination that preserves the facts, restrictions, and evidence behind textile decisions.

ILIEN receives a production exception from a source application, creates a live dependency graph, contacts authorized people through their available channels, records replies as evidence, and returns a scoped outcome. It uses Amazon SES and AWS End User Messaging Social for two-way communication and Amazon Bedrock for bounded next-step proposals. Deterministic policy checks retain authority over sending, approvals, and completion.

## Repository material

- [Architecture diagram](architecture.svg)
- [Working flow](coordination-flow.svg)
- [Run and safety instructions](OPERATIONS.md)
- [MIT License](../LICENSE)

The code imports and calls both qualifying AWS CDS SDK clients: `@aws-sdk/client-sesv2` for `SendEmailCommand`, and `@aws-sdk/client-socialmessaging` for `SendWhatsAppMessageCommand`.

## Devpost form content

| Field | Value to enter |
| --- | --- |
| Project name | ILIEN — Evidence-Preserving Textile Coordination |
| Tagline | Omnichannel coordination that preserves the facts, restrictions, and evidence behind textile decisions. |
| Built with | TypeScript, AWS Lambda, Amazon SQS, Amazon Aurora PostgreSQL, Amazon Bedrock, Amazon SES, AWS End User Messaging Social, Amazon SNS, Amazon S3, AWS Secrets Manager, Terraform |
| Architecture image | `docs/architecture.svg` |
| Repository | Public repository URL |
| Test instructions | README and `docs/OPERATIONS.md` |
| WhatsApp prize description | ILIEN uses AWS End User Messaging Social to send WhatsApp Business coordination requests and process provider events within an evidence-bound case. It preserves WhatsApp session/template blocks as visible case state rather than treating them as successful delivery. |

## Before submission

1. Add the real deployed project URL and working judge access/test instructions.
2. Add a public YouTube or Vimeo demo, about three minutes, showing the running project.
3. Create a net-new ACE opportunity and add its ID. Use campaign code `AWS CDS Agentic AI Hackathon -Sept. 2026`.
4. Confirm the public repository displays the MIT license and contains all source, assets, and run instructions.
5. Verify that the video and text distinguish recorded provider delivery, participant response, and source outcome from factory action.

The related Devpost rules require a repository, runtime use of a qualifying CDS SDK, architecture diagram, project description, public video, deployed/testable access, ACE opportunity ID, and an open-source license for a public repository. Review the current rules before final submission.
