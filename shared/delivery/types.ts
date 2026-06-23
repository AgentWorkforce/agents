import type { WorkforceCtx } from '@agentworkforce/runtime';
import type { SlackClient } from '@relayfile/relay-helpers';
import type { TelegramClient } from '@relayfile/relay-helpers';
import { input } from './helpers.js';

// ── message reference (returned by send, accepted by reply) ──────────────

export interface SlackRef {
  provider: 'slack';
  channel: string;
  /** Delivered message ts (set after the writeback receipt arrives). */
  ts: string;
  /** Draft ref for cloud-side replyTo threading. */
  draftRef: string;
}

export interface TelegramRef {
  provider: 'telegram';
  chatId: string;
  /** Delivered message id (set after the writeback receipt arrives). */
  messageId: string;
}

export type MessageRef = SlackRef | TelegramRef;

// ── delivery result ─────────────────────────────────────────────────────

export interface DeliveryResult {
  ok: boolean;
  refs: MessageRef[];
}

// ── options ──────────────────────────────────────────────────────────────

export interface DeliveryOptions {
  /** Thread the message under a prior delivery result. */
  replyTo?: DeliveryResult;
  /**
   * When true, don't wait for the writeback receipt. Returns draft refs
   * immediately and relies on the cloud's server-side ordering for
   * threading (Slack parentRef pattern, Telegram sendMessage with 0ms
   * timeout). The returned refs have empty ts/messageId but valid
   * draftRef for use as a parent in subsequent threaded sends.
   *
   * Use this for the header in a header+threaded-body pattern so the
   * digest never blocks on a receipt — the cloud orders the threaded
   * body under the header server-side.
   */
  nonBlocking?: boolean;
}

// ── injectable transport seam (for tests) ────────────────────────────────

export interface DeliveryTransports {
  /** Injected Slack client (used for both blocking and non-blocking paths). */
  slack?: SlackClient;
  /** Injected Telegram client (used for both blocking and non-blocking paths). */
  telegram?: TelegramClient;
}

// ── delivery client ──────────────────────────────────────────────────────

export interface DeliveryClient {
  /**
   * Send a message to all configured targets.
   *
   * When `opts.replyTo` is set the message is threaded under the targets
   * from that prior `DeliveryResult`, each using its transport's native
   * threading mechanism.
   *
   * In blocking mode (default): waits for the writeback receipt and returns
   * the delivered ts/messageId. In non-blocking mode (`opts.nonBlocking: true`):
   * returns draft refs immediately with the relay path as draftRef — zero
   * receipt round-trips, cloud-side server ordering handles threading.
   */
  send(text: string, opts?: DeliveryOptions): Promise<DeliveryResult>;

  /**
   * Convenience: same as `send(text, { nonBlocking: true })`.
   * Publish a message without waiting for a receipt. Returns draft refs
   * immediately for use as a threading parent.
   */
  publish(text: string): Promise<DeliveryResult>;

  /** Which providers are configured. */
  readonly targets: ReadonlyArray<'slack' | 'telegram'>;
}

// ── configuration discovery ──────────────────────────────────────────────

/**
 * Resolve which transport targets are configured for the given persona ctx.
 * Uses input() helper for proper resolution order (ctx → env → default).
 */
export function resolveDeliveryTargets(ctx: WorkforceCtx): Array<'slack' | 'telegram'> {
  const targets: Array<'slack' | 'telegram'> = [];
  if (input(ctx, 'SLACK_CHANNEL')) targets.push('slack');
  if (input(ctx, 'TELEGRAM_CHAT')) targets.push('telegram');
  return targets;
}

/**
 * Get the configured slack channel id (bare, without `__name` suffix).
 * Uses input() for proper resolution.
 */
export function slackChannel(ctx: WorkforceCtx): string | undefined {
  const raw = input(ctx, 'SLACK_CHANNEL');
  return raw?.split('__')[0]?.trim() || undefined;
}

/**
 * Get the configured telegram chat id (bare, without `__title` suffix).
 * Uses input() for proper resolution.
 */
export function telegramChat(ctx: WorkforceCtx): string | undefined {
  const raw = input(ctx, 'TELEGRAM_CHAT');
  return raw?.split('__')[0]?.trim() || undefined;
}
