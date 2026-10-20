import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";
const s3 = new S3Client({ maxAttempts: 3 });
const str = z.string().max(2048);
const hash = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export interface Incoming {
  channel: "email" | "whatsapp";
  providerId: string;
  sender: string;
  text: string;
  raw: string;
  token?: string;
  replyTo?: string;
  timestamp?: string;
  blockedReason?: string;
  media?: unknown[];
  eventType?: string;
  channelMessageId?: string;
  deliveryFailure?: {
    code?: number | string;
    title?: string;
    message?: string;
  };
  object?: { bucket: string; key: string; sha256?: string };
}
const tokenIn = (text: string) =>
  text.match(/(?:^|\n)ILIEN ([a-f0-9]{32})(?:\s|$)/)?.[1];
export async function normalize(
  topic: string,
  raw: string,
): Promise<Incoming[]> {
  if (Buffer.byteLength(raw) > 245000) throw new Error("NotificationTooLarge");
  const input = JSON.parse(raw);
  if (topic === process.env.WHATSAPP_TOPIC_ARN) {
    const header = z
      .object({
        messageId: str.optional(),
        aws_account_id: str,
        context: z.object({
          MetaWabaIds: z.array(z.object({ arn: str })),
          MetaPhoneNumberIds: z.array(
            z.object({ arn: str, metaPhoneNumberId: str }),
          ),
        }),
        whatsAppWebhookEntry: z.string(),
      })
      .parse(input);
    if (
      header.aws_account_id !== process.env.AWS_ACCOUNT_ID ||
      !header.context.MetaWabaIds.some(
        (x) => x.arn === process.env.WHATSAPP_WABA_ARN,
      )
    )
      throw new Error("WrongChannelAccount");
    const phone = header.context.MetaPhoneNumberIds.find(
      (x) => x.arn === process.env.WHATSAPP_PHONE_ARN,
    );
    if (!phone) return [];
    const entry = z
      .object({
        changes: z
          .array(
            z.object({
              value: z.object({
                metadata: z.object({ phone_number_id: str }),
                messages: z
                  .array(
                    z
                      .object({
                        id: str,
                        from: str,
                        timestamp: str,
                        type: str,
                        text: z
                          .object({ body: z.string().max(16000) })
                          .optional(),
                        context: z.object({ id: str }).optional(),
                      })
                      .passthrough(),
                  )
                  .max(100)
                  .optional(),
                statuses: z
                  .array(
                    z.object({
                      id: str,
                      status: str,
                      timestamp: str,
                      errors: z
                        .array(
                          z.object({
                            code: z.union([z.number(), z.string()]).optional(),
                            title: str.optional(),
                            message: str.optional(),
                          }),
                        )
                        .optional(),
                    }),
                  )
                  .max(100)
                  .optional(),
              }),
            }),
          )
          .max(100),
      })
      .parse(JSON.parse(header.whatsAppWebhookEntry));
    const output: Incoming[] = [];
    for (const change of entry.changes) {
      const v = change.value;
      if (v.metadata.phone_number_id !== phone.metaPhoneNumberId) continue;
      for (const m of v.messages ?? []) {
        const text = m.text?.body ?? "";
        const time = Number(m.timestamp) * 1000;
        output.push({
          channel: "whatsapp",
          providerId: m.id,
          sender: m.from,
          text,
          token: tokenIn(text),
          replyTo: m.context?.id,
          timestamp: Number.isFinite(time)
            ? new Date(time).toISOString()
            : undefined,
          raw,
          blockedReason: m.type !== "text" ? "unsupported_media" : undefined,
          media:
            m.type !== "text" ? [{ type: m.type, descriptor: m[m.type] }] : [],
        });
      }
      for (const status of v.statuses ?? [])
        output.push({
          channel: "whatsapp",
          providerId: header.messageId ?? status.id,
          channelMessageId: status.id,
          deliveryFailure: status.errors?.[0],
          sender: "",
          text: "",
          raw,
          eventType: status.status,
          timestamp: new Date(Number(status.timestamp) * 1000).toISOString(),
        });
    }
    return output;
  }
  if (topic === process.env.EMAIL_TOPIC_ARN) {
    const data = z
      .object({
        notificationType: z.literal("Received"),
        receipt: z.object({
          recipients: z.array(str),
          spamVerdict: z.object({ status: str }),
          virusVerdict: z.object({ status: str }),
          dkimVerdict: z.object({ status: str }),
          dmarcVerdict: z.object({ status: str }).optional(),
          action: z.object({
            type: z.literal("S3"),
            bucketName: str,
            objectKey: str,
          }),
        }),
        mail: z.object({
          messageId: str,
          timestamp: str,
          headersTruncated: z.boolean().optional(),
        }),
      })
      .parse(input);
    const action = data.receipt.action;
    if (
      action.bucketName !== process.env.CHANNEL_BUCKET ||
      !action.objectKey.startsWith("raw/")
    )
      throw new Error("WrongEvidenceLocation");
    const addressed = data.receipt.recipients
      .map(
        (r) =>
          new RegExp(
            `^r\\+([a-f0-9]{32})@${process.env.MAIL_DOMAIN!.replaceAll(".", "\\.")}$`,
            "i",
          ).exec(r)?.[1],
      )
      .filter((x): x is string => !!x);
    const genericAddressed = data.receipt.recipients.some((r) =>
      ["requests", "inbox"].some(
        (local) =>
          r.toLowerCase() ===
          `${local}@${process.env.MAIL_DOMAIN!.toLowerCase()}`,
      ),
    );
    const item: Incoming = {
      channel: "email",
      providerId: data.mail.messageId,
      sender: "",
      text: "",
      raw,
      timestamp: data.mail.timestamp,
      object: { bucket: action.bucketName, key: action.objectKey },
      token: addressed.length === 1 ? addressed[0] : undefined,
    };
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: action.bucketName,
        Key: action.objectKey,
      }),
    );
    if (!result.ContentLength || result.ContentLength > 1048576) {
      if (result.Body && "destroy" in result.Body) result.Body.destroy();
      return [{ ...item, blockedReason: "oversized_email" }];
    }
    const bytes = await result.Body!.transformToByteArray();
    item.object!.sha256 = hash(bytes);
    const mail = await simpleParser(Buffer.from(bytes), {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
    });
    item.sender =
      mail.from?.value.length === 1
        ? (mail.from.value[0]?.address?.toLowerCase() ?? "")
        : "";
    item.text = (mail.text ?? "").slice(0, 16000);
    item.media = mail.attachments.map((a) => ({
      name: a.filename,
      type: a.contentType,
      size: a.size,
      sha256: hash(a.content),
      state: "quarantined",
    }));
    item.replyTo = Array.isArray(mail.inReplyTo)
      ? mail.inReplyTo[0]
      : mail.inReplyTo;
    if (
      data.receipt.spamVerdict.status !== "PASS" ||
      data.receipt.virusVerdict.status !== "PASS" ||
      data.receipt.dkimVerdict.status !== "PASS" ||
      data.receipt.dmarcVerdict?.status !== "PASS" ||
      data.mail.headersTruncated
    )
      item.blockedReason = "email_authentication_or_scan_failed";
    else if (
      mail.headers.get("auto-submitted") &&
      mail.headers.get("auto-submitted") !== "no"
    )
      item.blockedReason = "automatic_reply";
    else if (item.media.length) item.blockedReason = "attachments_quarantined";
    else if (
      !item.sender ||
      addressed.length > 1 ||
      (!addressed.length && !genericAddressed)
    )
      item.blockedReason = "ambiguous_email_identity_or_route";
    else if ((mail.text?.length ?? 0) > 16000)
      item.blockedReason = "body_too_large";
    return [item];
  }
  if (topic === process.env.EMAIL_EVENTS_TOPIC_ARN) {
    const data = z
      .object({
        eventType: str,
        mail: z.object({ messageId: str, timestamp: str }),
      })
      .parse(input);
    return [
      {
        channel: "email",
        providerId: data.mail.messageId,
        sender: "",
        text: "",
        raw,
        eventType: data.eventType.toLowerCase(),
        timestamp: data.mail.timestamp,
      },
    ];
  }
  throw new Error("UntrustedTopic");
}

export async function boundedEvidence(item: Incoming): Promise<Incoming> {
  if (Buffer.byteLength(item.raw) > 30000) {
    const digest = hash(item.raw),
      key = `notifications/${digest}.json`;
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.CHANNEL_BUCKET!,
          Key: key,
          Body: item.raw,
          ContentType: "application/json",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
          ?.httpStatusCode !== 412
      )
        throw error;
    }
    item.raw = JSON.stringify({
      storage: "s3",
      bucket: process.env.CHANNEL_BUCKET,
      key,
      sha256: digest,
      representation: "original_provider_notification",
    });
  }
  if (Buffer.byteLength(JSON.stringify({ ...item, raw: undefined })) > 30000) {
    item.text = "";
    item.media = [];
    item.blockedReason = "normalized_view_limit_original_retained";
  }
  return item;
}
