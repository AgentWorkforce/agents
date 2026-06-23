import { slackClient, telegramClient } from '@relayfile/relay-helpers';
import type { SlackClient, TelegramClient } from '@relayfile/relay-helpers';
import type { WorkforceCtx } from '@agentworkforce/runtime';
import {
  resolveDeliveryTargets,
  slackChannel,
  telegramChat,
  type DeliveryClient,
  type DeliveryOptions,
  type DeliveryResult,
  type DeliveryTransports,
  type SlackRef,
  type TelegramRef
} from './types.js';

const WRITEBACK_TIMEOUT_MS = 45_000;

/**
 * Create a delivery client that auto-discovers configured transports from
 * the persona context and sends to all of them.
 *
 * Blocking mode (the default):
 *   const heads = await delivery.send(header);
 *   await delivery.send(body, { replyTo: heads });
 *
 * Non-blocking parentRef mode (zero receipt round-trips):
 *   const heads = await delivery.publish(header);
 *   await delivery.send(body, { replyTo: heads, nonBlocking: true });
 *
 * Pass `transports` to inject mock clients for testing — the same injected
 * client is used for both blocking and non-blocking paths (tests supply
 * their own mock that short-circuits the writeback).
 */
export function createDelivery(
  ctx: WorkforceCtx,
  transports?: DeliveryTransports,
  /** Override which transports to target (defaults to all configured). */
  onlyTargets?: ReadonlyArray<'slack' | 'telegram'>
): DeliveryClient {
  const allTargets = resolveDeliveryTargets(ctx);
  const targets = onlyTargets
    ? allTargets.filter((t) => (onlyTargets as readonly string[]).includes(t))
    : allTargets;

  // Injected transports take priority. When not injected, construct real
  // clients with appropriate timeouts.
  const injectedSlack = transports?.slack;
  const injectedTelegram = transports?.telegram;

  const slackBlocking = injectedSlack ?? (targets.includes('slack')
    ? slackClient({ writebackTimeoutMs: WRITEBACK_TIMEOUT_MS })
    : undefined);
  const slackNonBlocking = injectedSlack ?? (targets.includes('slack')
    ? slackClient({ writebackTimeoutMs: 0 })
    : undefined);
  const telegramBlocking = injectedTelegram ?? (targets.includes('telegram')
    ? telegramClient({ writebackTimeoutMs: WRITEBACK_TIMEOUT_MS })
    : undefined);
  const telegramNonBlocking = injectedTelegram ?? (targets.includes('telegram')
    ? telegramClient({ writebackTimeoutMs: 0 })
    : undefined);

  return new DeliveryClientImpl(ctx, targets, {
    slackBlocking,
    slackNonBlocking,
    telegramBlocking,
    telegramNonBlocking
  });
}

interface DeliveryTransportsInternal {
  slackBlocking?: SlackClient;
  slackNonBlocking?: SlackClient;
  telegramBlocking?: TelegramClient;
  telegramNonBlocking?: TelegramClient;
}

class DeliveryClientImpl implements DeliveryClient {
  readonly targets: ReadonlyArray<'slack' | 'telegram'>;

  private ctx: WorkforceCtx;
  private t: DeliveryTransportsInternal;

  constructor(
    ctx: WorkforceCtx,
    targets: Array<'slack' | 'telegram'>,
    transports: DeliveryTransportsInternal
  ) {
    this.ctx = ctx;
    this.targets = targets;
    this.t = transports;
  }

  async send(text: string, opts?: DeliveryOptions): Promise<DeliveryResult> {
    const nonBlocking = opts?.nonBlocking === true;
    const refs: Array<SlackRef | TelegramRef> = [];
    const errors: string[] = [];

    const tasks: Promise<void>[] = [];

    for (const target of this.targets) {
      const parentRef = opts?.replyTo?.refs.find((r) => r.provider === target);
      if (target === 'slack') {
        tasks.push(
          this.sendSlack(text, parentRef as SlackRef | undefined, nonBlocking)
            .then((ref) => { if (ref) refs.push(ref); })
            .catch((err) => { errors.push(`slack: ${String(err)}`); })
        );
      }
      if (target === 'telegram') {
        tasks.push(
          this.sendTelegram(text, parentRef as TelegramRef | undefined, nonBlocking)
            .then((ref) => { if (ref) refs.push(ref); })
            .catch((err) => { errors.push(`telegram: ${String(err)}`); })
        );
      }
    }

    await Promise.all(tasks);

    // In non-blocking mode, draft refs always succeed (no receipt wait to fail).
    // Treat any ref as success. In blocking mode, require all targets to succeed.
    const ok = nonBlocking
      ? refs.length > 0
      : errors.length === 0 && refs.length === this.targets.length;

    if (!ok && errors.length > 0) {
      this.ctx.log?.('warn', 'delivery.partial-failure', { errors, nonBlocking });
    }
    if (!ok && refs.length === 0) {
      const detail = errors.length > 0 ? errors.join('; ') : 'all sends returned null (no configured targets)';
      throw new Error(`Delivery failed to all targets: ${detail}`);
    }

    return { ok, refs };
  }

  async publish(text: string): Promise<DeliveryResult> {
    return this.send(text, { nonBlocking: true });
  }

  // ── Slack ──────────────────────────────────────────────────────────────

  private async sendSlack(
    text: string,
    parentRef: SlackRef | undefined,
    nonBlocking: boolean
  ): Promise<SlackRef | null> {
    const channel = slackChannel(this.ctx);
    if (!channel) return null;

    if (nonBlocking) {
      return this.sendSlackNonBlocking(channel, text, parentRef);
    }
    return this.sendSlackBlocking(channel, text, parentRef);
  }

  private async sendSlackBlocking(
    channel: string,
    text: string,
    parentRef?: SlackRef
  ): Promise<SlackRef | null> {
    const client = this.t.slackBlocking;
    if (!client) return null;

    const result = parentRef?.draftRef
      ? await client.post(channel, text, { replyTo: parentRef.draftRef })
      : await client.post(channel, text);

    if (!result.ts) {
      this.ctx.log?.('warn', 'delivery.slack.no-receipt', { channel });
      return null;
    }

    return {
      provider: 'slack',
      channel: result.channel,
      ts: result.ts,
      draftRef: result.ref
    };
  }

  /**
   * Non-blocking Slack: uses messages.write() directly with writebackTimeoutMs:0.
   * The parentRef is embedded in the message body so the cloud orders the message
   * under the parent server-side — zero receipt round-trips. The returned draftRef
   * is the relay path, usable as a parent for subsequent threaded sends.
   *
   * Mirrors the x-reply-radar parentRef threading pattern (internal-agents).
   */
  private async sendSlackNonBlocking(
    channel: string,
    text: string,
    parentRef?: SlackRef
  ): Promise<SlackRef | null> {
    const client = this.t.slackNonBlocking;
    if (!client) return null;

    const body: Record<string, unknown> = { text };
    if (parentRef?.draftRef) {
      // Embed parentRef in the body — the cloud lifts it from the streamed head
      // and orders this message under the parent once the parent delivers.
      body.parentRef = parentRef.draftRef;
    }

    const result = await client.messages.write({ channelId: channel }, body);

    return {
      provider: 'slack',
      channel,
      ts: '', // Not available yet (non-blocking)
      draftRef: result.path
    };
  }

  // ── Telegram ───────────────────────────────────────────────────────────

  private async sendTelegram(
    text: string,
    parentRef: TelegramRef | undefined,
    nonBlocking: boolean
  ): Promise<TelegramRef | null> {
    const chatId = telegramChat(this.ctx);
    if (!chatId) return null;

    const client = nonBlocking ? this.t.telegramNonBlocking : this.t.telegramBlocking;
    if (!client) return null;

    const result = parentRef?.messageId
      ? await client.sendMessage(chatId, text, { replyToMessageId: Number(parentRef.messageId) || undefined })
      : await client.sendMessage(chatId, text);

    if (!nonBlocking && !result.ok) {
      this.ctx.log?.('warn', 'delivery.telegram.no-receipt', { chatId });
      return null;
    }

    return {
      provider: 'telegram',
      chatId: result.chatId != null ? String(result.chatId) : chatId,
      messageId: result.ok ? result.messageId : ''
    };
  }
}
