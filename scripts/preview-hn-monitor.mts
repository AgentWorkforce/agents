#!/usr/bin/env node
/**
 * Read-only live preview of hn-monitor discovery + deterministic formatting.
 * It fetches HN but never invokes a model, writes memory, or posts anywhere.
 */
import {
  fetchHackerNewsFeeds,
  renderDigest,
  selectRelevantStories,
} from '../hn-monitor/agent.js';

const topics = (process.env.TOPICS ?? [
  'AI agents',
  'coding agents',
  'multi-agent',
  'agent orchestration',
  'agent workflows',
  'agent runtime',
  'agent memory',
  'MCP',
  'Claude Code',
  'Codex',
  'Cursor',
  'software factory',
  'developer tooling',
].join(','))
  .split(',')
  .map((topic) => topic.trim())
  .filter(Boolean);

const lookbackHours = positiveInt(process.env.LOOKBACK_HOURS ?? '24', 'LOOKBACK_HOURS');
const maxStories = positiveInt(process.env.MAX_STORIES ?? '8', 'MAX_STORIES');
const candidates = await fetchHackerNewsFeeds(lookbackHours);
const selected = selectRelevantStories(candidates, topics, maxStories);
const digest = renderDigest(selected, {
  theme: selected.length
    ? 'Deterministic preview — production adds a model-written batch theme and a specific why-it-matters note per story.'
    : 'No current stories crossed the agentic relevance threshold.',
  whyById: new Map(),
});

console.log(JSON.stringify({
  lookbackHours,
  candidates: candidates.length,
  selected: selected.map((story) => ({
    id: story.id,
    title: story.title,
    category: story.category,
    relevanceScore: story.relevanceScore,
    points: story.points,
    comments: story.comments,
    feeds: story.feeds,
    url: story.url,
    hnUrl: story.hnUrl,
  })),
}, null, 2));
console.log('\n--- Slack preview ---\n');
console.log(digest.header);
console.log('\n' + digest.body);

function positiveInt(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
