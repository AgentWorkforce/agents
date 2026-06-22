/**
 * Prompt construction for inbox-buddy's chat path. Pure and deterministic so it
 * can be golden-tested: the assembled prompt is the contract that proves both
 * threading behaviours — conversational continuity (the transcript section) and
 * email threading (the focused full-thread section for referenced threads).
 */
import {
  type GmailThread,
  compactThreadOverview,
  expandThread,
  selectThreads
} from './gmail.js';
import { type ConvTurn, renderTranscript } from './conversation.js';

export const SYSTEM_PROMPT = `You are inbox-buddy, a concise assistant with read access to the user's recent Gmail.

You answer questions about the user's email over a multi-turn conversation.

Rules:
- Ground every answer ONLY in the email data and conversation provided below. Do not invent senders, subjects, or facts. If the data doesn't cover the question, say so plainly.
- This is a continuing conversation. Use the earlier turns to resolve references like "that one", "the first thread", "reply to him", or "what did I just ask".
- When a follow-up uses a pronoun ("she", "him", "that thread"), resolve it and NAME the person/thread/subject explicitly in your answer so the reply stands on its own (e.g. "Alice looped in finance@acme.com").
- When the user refers to a specific thread or person, reason over that thread's FULL message list (the "Threads in focus" section), not just a one-line snippet.
- Cite concrete details — subject line, sender, date — so the user can find the email.
- Be brief and skimmable. Prefer a tight bullet list over a paragraph.
- You can READ email but cannot send replies yet. If asked to reply/forward, draft the text and say it is a draft (sending in-thread is not enabled yet).`;

export interface BuildPromptArgs {
  question: string;
  transcript: ConvTurn[];
  threads: GmailThread[];
  /** How many recent threads to include as a compact overview. */
  overviewLimit?: number;
  /** How many query-matched threads to expand in full. */
  focusLimit?: number;
}

/**
 * Assemble the full prompt: system role + prior transcript + recent-thread
 * overview + any threads matching the current question (expanded in full) +
 * the current question. Returns the user-message body to pass to
 * `ctx.llm.complete` after the system preamble.
 */
export function buildPrompt(args: BuildPromptArgs): string {
  const overviewLimit = args.overviewLimit ?? 25;
  const focusLimit = args.focusLimit ?? 5;

  const focused = selectThreads(args.threads, args.question, focusLimit);
  const focusedIds = new Set(focused.map((t) => t.id));
  const overview = args.threads.slice(0, overviewLimit).map(compactThreadOverview);

  const sections: string[] = [];

  const transcript = renderTranscript(args.transcript);
  if (transcript) {
    sections.push(`## Conversation so far\n${transcript}`);
  }

  sections.push(
    args.threads.length > 0
      ? `## Recent threads (${args.threads.length} loaded, newest first)\n${JSON.stringify(overview, null, 2)}`
      : '## Recent threads\nNo Gmail threads are visible in the mount yet.'
  );

  if (focused.length > 0) {
    const detail = focused.map(expandThread);
    sections.push(
      `## Threads in focus (matched to this question — reason over the full message list)\n${JSON.stringify(detail, null, 2)}`
    );
  }

  sections.push(`## Current question\n${args.question}`);

  // Expose which threads were matched so callers can log/observe email-threading.
  void focusedIds;
  return sections.join('\n\n');
}

/** Thread ids matched to a question — used by the handler for observability. */
export function focusedThreadIds(threads: GmailThread[], question: string, focusLimit = 5): string[] {
  return selectThreads(threads, question, focusLimit).map((t) => t.id);
}
