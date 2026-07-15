import { defineAgent } from '@agentworkforce/runtime';
import { createDelivery, type DeliveryResult, type SlackRef } from '@agentworkforce/delivery';

const THREAD_LINK_TAG = 'acceptance:preview-thread-link';

interface StoredSlackRef {
  provider: 'slack';
  channel: string;
  draftRef: string;
  ts: string;
}

interface MemoryEntry {
  content?: string;
  createdAt?: string;
}

function latest(items: MemoryEntry[]): MemoryEntry | null {
  return [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0] ?? null;
}

function parseStoredSlackRef(content: string | undefined): StoredSlackRef | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (
      parsed &&
      parsed.provider === 'slack' &&
      typeof parsed.channel === 'string' &&
      typeof parsed.draftRef === 'string' &&
      typeof parsed.ts === 'string'
    ) {
      return parsed;
    }
  } catch {
    // Ignore malformed previews and fall back to a fresh parent message.
  }
  return null;
}

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 * * * *', tz: 'UTC' }],
  handler: async (ctx) => {
    const delivery = createDelivery(ctx, undefined, ['slack']);
    const recalled = await ctx.memory.recall('acceptance preview thread link', {
      tags: [THREAD_LINK_TAG],
      scope: 'workspace',
      limit: 5,
    });
    const stored = parseStoredSlackRef(latest(recalled)?.content);

    if (!stored) {
      const parent = await delivery.publish('acceptance preview thread parent');
      const parentRef = parent.refs.find((ref): ref is SlackRef => ref.provider === 'slack');
      if (!parentRef) throw new Error('Expected a Slack preview ref from the acceptance parent send');
      await ctx.memory.save(JSON.stringify(parentRef), {
        tags: [THREAD_LINK_TAG],
        scope: 'workspace',
      });
      ctx.log('info', 'acceptance.preview-thread-link.parent', {
        draftRef: parentRef.draftRef,
        threadTs: parentRef.ts,
      });
      return;
    }

    const replyTo: DeliveryResult = {
      ok: true,
      refs: [stored],
    };
    const reply = await delivery.send('acceptance preview thread reply', {
      replyTo,
      nonBlocking: true,
    });
    const replyRef = reply.refs.find((ref): ref is SlackRef => ref.provider === 'slack');
    if (!replyRef) throw new Error('Expected a Slack preview ref from the acceptance reply send');
    ctx.log('info', 'acceptance.preview-thread-link.reply', {
      parentDraftRef: stored.draftRef,
      parentThreadTs: stored.ts,
      replyDraftRef: replyRef.draftRef,
      replyThreadTs: replyRef.ts,
    });
  },
});
