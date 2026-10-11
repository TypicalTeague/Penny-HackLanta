import { createHash } from "node:crypto";
import { Spectrum, attachment, poll } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type {
  PendingVerification,
  VerificationProvider,
} from "../auth/auth0.js";
import type { PennyService } from "../application/penny.js";

export async function runSpectrum(
  service: PennyService,
  verification: VerificationProvider,
  projectId: string,
  projectSecret: string,
): Promise<void> {
  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });
  console.log(JSON.stringify({ event: "spectrum_ready" }));
  const schedulerMs = Number(
    process.env.PENNY_SCHEDULER_INTERVAL_MS ?? "3600000",
  );
  const scheduler = setInterval(
    () => {
      void sendDueWeeklyUpdates(service, app);
    },
    Number.isFinite(schedulerMs) && schedulerMs >= 60_000
      ? schedulerMs
      : 3_600_000,
  );
  scheduler.unref();
  for await (const [space, message] of app.messages) {
    if (
      message.direction === "outbound" ||
      (message.content.type !== "text" &&
        message.content.type !== "poll_option")
    )
      continue;
    const rawSenderId = message.sender?.id;
    if (!rawSenderId) continue;
    const platform =
      (message.sender as { __platform?: string }).__platform ?? "imessage";
    const photonUserId = `photon_${createHash("sha256").update(`${platform}:${rawSenderId}`).digest("hex")}`;
    const text =
      message.content.type === "text"
        ? message.content.text
        : message.content.selected
          ? message.content.option.title
          : "";
    if (!text) continue;
    const startedAt = Date.now();
    const messageRef = reference(message.id);
    console.log(JSON.stringify({ event: "message_received", messageRef }));
    try {
      await space.responding(async () => {
        try {
          await message.react("like");
        } catch {
          console.warn(
            JSON.stringify({ event: "tapback_unavailable", messageRef }),
          );
        }
        const reply = await service.handle({
          id: message.id,
          photonUserId,
          photonSpaceId: space.id,
          legacySenderKey: rawSenderId,
          text,
        });
        await sendReply(space, message, reply);
        await service.acknowledgeMessage(message.id);
        console.log(
          JSON.stringify({
            event: "message_completed",
            messageRef,
            durationMs: Date.now() - startedAt,
            duplicate: reply.duplicate ?? false,
          }),
        );
        if (reply.verification && reply.userId)
          void finishVerification(
            service,
            verification,
            reply.userId,
            reply.verification,
            space,
          );
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "message_failed",
          messageRef,
          durationMs: Date.now() - startedAt,
          errorRef: reference(String(error)),
        }),
      );
      try {
        await message.reply(
          "I hit a temporary delay and made no changes. Please try that message once more.",
        );
      } catch {
        console.error(
          JSON.stringify({ event: "error_reply_failed", messageRef }),
        );
      }
    }
  }
}

async function sendDueWeeklyUpdates(
  service: PennyService,
  app: Awaited<ReturnType<typeof Spectrum>>,
): Promise<void> {
  for (const target of await service.listUsersDueForWeeklyUpdate()) {
    try {
      const space = await imessage(app).space.get(target.photonSpaceId);
      await sendReply(
        space,
        undefined,
        await service.createProactiveUpdateReply(target.userId),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "weekly_update_failed",
          userRef: reference(target.userId),
          errorRef: reference(String(error)),
        }),
      );
    }
  }
}

function reference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

async function finishVerification(
  service: PennyService,
  provider: VerificationProvider,
  userId: string,
  challenge: PendingVerification,
  space: { send(content: string): Promise<unknown> },
): Promise<void> {
  try {
    const identity = await provider.waitForVerification(challenge);
    await space.send(
      await service.completeVerification(userId, challenge, identity),
    );
    if (challenge.action === "approve_plan") {
      const delayMs = Number(process.env.PENNY_UPDATE_DELAY_MS ?? "30000");
      setTimeout(
        () => {
          void service
            .createProactiveUpdateReply(userId)
            .then((update) => sendReply(space, undefined, update))
            .catch((error: unknown) => {
              const ref = createHash("sha256")
                .update(String(error))
                .digest("hex")
                .slice(0, 8);
              console.error(
                JSON.stringify({ event: "proactive_update_failed", ref }),
              );
            });
        },
        Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 30_000,
      );
    }
  } catch (error) {
    const ref = createHash("sha256")
      .update(String(error))
      .digest("hex")
      .slice(0, 8);
    console.error(JSON.stringify({ event: "verification_failed", ref }));
    await space.send(
      "Verification didn’t complete, so I made no changes. You can try again when you’re ready.",
    );
  }
}

async function sendReply(
  space: { send(content: unknown): Promise<unknown> },
  source: { reply(content: unknown): Promise<unknown> } | undefined,
  reply: import("../application/penny.js").PennyReply,
): Promise<void> {
  const parts =
    reply.parts ??
    (reply.text ? [{ type: "text" as const, text: reply.text }] : []);
  for (const part of parts) {
    if (part.type === "text") {
      if (source) await source.reply(part.text);
      else await space.send(part.text);
    } else if (part.type === "poll") {
      await space.send(poll(part.title, part.options));
    } else {
      const content = attachment(part.data, {
        name: part.name,
        mimeType: part.mimeType,
      });
      if (source) await source.reply(content);
      else await space.send(content);
    }
  }
}
