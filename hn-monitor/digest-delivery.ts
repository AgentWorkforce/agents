import type { WorkforceCtx } from '@agentworkforce/runtime';
import {
  resolveDeliveryTargets,
  slackChannel,
  telegramChat,
  type DeliveryProvider,
  type MessageRef
} from '@agentworkforce/delivery';
import { slackClient, telegramClient } from '@relayfile/relay-helpers';

const WRITEBACK_TIMEOUT_MS = 45_000;

export type DigestProvider = Extract<DeliveryProvider, 'slack' | 'telegram'>;

export interface DigestDeliveryOptions {
  idempotencyKey: string;
  nonBlocking?: boolean;
  replyTo?: MessageRef;
}

/** The scheduled digest uses stable, caller-owned operation keys. */
export interface DigestDeliveryClient {
  readonly targets: ReadonlyArray<DigestProvider>;
  sendOperation(
    provider: DigestProvider,
    text: string,
    options: DigestDeliveryOptions
  ): Promise<MessageRef>;
}

/**
 * Provider-specific delivery seam for the durable digest outbox. Writing the
 * stable idempotency key into the provider draft makes a replay after worker
 * termination safe even though the next cron tick has a different delivery id.
 */
export function createDigestDelivery(ctx: WorkforceCtx): DigestDeliveryClient {
  const targets = resolveDeliveryTargets(ctx).filter(
    (provider): provider is DigestProvider => provider === 'slack' || provider === 'telegram'
  );

  return {
    targets,
    async sendOperation(provider, text, options) {
      if (!targets.includes(provider)) throw new Error(`HN digest provider ${provider} is not configured`);
      return provider === 'slack'
        ? sendSlackOperation(ctx, text, options)
        : sendTelegramOperation(ctx, text, options);
    }
  };
}

async function sendSlackOperation(
  ctx: WorkforceCtx,
  text: string,
  options: DigestDeliveryOptions
): Promise<MessageRef> {
  const channel = slackChannel(ctx);
  if (!channel) throw new Error('HN digest Slack channel is not configured');
  const parent = options.replyTo?.provider === 'slack' ? options.replyTo : undefined;
  const client = slackClient({ writebackTimeoutMs: options.nonBlocking ? 0 : WRITEBACK_TIMEOUT_MS });
  const result = await client.messages.write({ channelId: channel }, {
    text,
    idempotencyKey: options.idempotencyKey,
    ...(parent?.draftRef ? { parentRef: parent.draftRef } : {})
  });
  const ts = receiptId(result.receipt);
  if (!options.nonBlocking && !ts) throw new Error(`HN digest Slack operation ${options.idempotencyKey} returned no receipt`);
  return { provider: 'slack', channel, ts, draftRef: result.path };
}

async function sendTelegramOperation(
  ctx: WorkforceCtx,
  text: string,
  options: DigestDeliveryOptions
): Promise<MessageRef> {
  const chatId = telegramChat(ctx);
  if (!chatId) throw new Error('HN digest Telegram chat is not configured');
  const parent = options.replyTo?.provider === 'telegram' ? options.replyTo : undefined;
  const parentMessageId = parent?.messageId ? Number(parent.messageId) : undefined;
  const client = telegramClient({ writebackTimeoutMs: options.nonBlocking ? 0 : WRITEBACK_TIMEOUT_MS });
  const result = await client.messages.write({ chatId }, {
    text,
    idempotencyKey: options.idempotencyKey,
    ...(Number.isSafeInteger(parentMessageId) ? { reply_to_message_id: parentMessageId } : {})
  });
  const messageId = receiptId(result.receipt);
  if (!options.nonBlocking && !messageId) {
    throw new Error(`HN digest Telegram operation ${options.idempotencyKey} returned no receipt`);
  }
  return { provider: 'telegram', chatId, messageId };
}

function receiptId(receipt: Record<string, unknown> | undefined): string {
  if (!receipt) return '';
  for (const value of [receipt.externalId, receipt.ts, receipt.messageId, receipt.message_id, receipt.created, receipt.id]) {
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}
