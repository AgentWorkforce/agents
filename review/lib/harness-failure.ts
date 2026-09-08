export interface HarnessFailure {
  kind: 'usage_limit' | 'rate_limit' | 'authentication' | 'context_limit' | 'provider_unavailable' | 'timeout' | 'unknown';
  message: string;
  resetHint?: string;
}

/**
 * Classify failed model CLI runs, never arbitrary successful review text.
 * Customer messages are fixed templates, not excerpts of stdout/stderr:
 * those streams can contain code, credentials, and unfinished review drafts.
 */
export function describeHarnessFailure(run: unknown, exitCode: number): HarnessFailure {
  const result = run as { output?: unknown; stderr?: unknown } | null;
  const text = [result?.output, result?.stderr]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.slice(-16000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))
    .join('\n');

  const claudeLimit = text.match(/^\s*You['’]ve hit your limit\b([^\r\n]*)/im);
  if (claudeLimit) {
    // Only copy a clock time with an explicit timezone. Do not echo the
    // remainder of an arbitrary line or invent an absolute reset date.
    const reset = claudeLimit[1].match(
      /\bresets\s+((?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]m|(?:[01]?\d|2[0-3]):[0-5]\d)\s*\((UTC|GMT|[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\)(?=$|[\s.,;])/i,
    );
    const resetHint = reset ? `${reset[1].trim()} (${reset[2]})` : undefined;
    return {
      kind: 'usage_limit',
      message: [
        'The Claude account used for this review has reached its usage limit.',
        ...(resetHint ? [`The provider reports a reset at ${resetHint}.`] : []),
        'Wait for the limit to reset, or ask the account owner to restore available usage before retrying the review.',
      ].join(' '),
      ...(resetHint ? { resetHint } : {}),
    };
  }

  if (/"(?:type|code)"\s*:\s*"(?:insufficient_quota|billing_hard_limit_reached)"|\byou exceeded your current quota\b|\byour credit balance is too low to access the Anthropic API\b/i.test(text)) {
    return {
      kind: 'usage_limit',
      message: 'The AI account used for this review has no available quota or credits. Ask the account owner to check usage and billing and restore capacity before retrying the review.',
    };
  }

  if (/"(?:type|code)"\s*:\s*"(?:rate_limit_error|rate_limit_exceeded)"|^\s*API Error:\s*429\b|\bThis request would exceed your account's rate limit\b/im.test(text)) {
    return {
      kind: 'rate_limit',
      message: 'The AI provider rate-limited this review. Wait for available capacity before retrying; if this persists, ask the account owner to check the account limits.',
    };
  }

  if (/"(?:type|code)"\s*:\s*"(?:authentication_error|invalid_api_key)"|^\s*API Error:\s*401\b|^\s*Invalid API key\b.*\/login|\bOAuth token has expired\b/im.test(text)) {
    return {
      kind: 'authentication',
      message: 'The AI provider rejected the credentials used for this review. Ask the account owner to reconnect the AI account before retrying the review.',
    };
  }

  if (/"(?:type|code)"\s*:\s*"context_length_exceeded"|"message"\s*:\s*"prompt is too long\b|^\s*(?:API Error:\s*400\s+)?prompt is too long\b/im.test(text)) {
    return {
      kind: 'context_limit',
      message: 'The review input exceeds the AI model context limit. The reviewer needs a smaller review scope or a model with a larger context window before retrying.',
    };
  }

  if (/^\s*API Error:\s*(?:Request timed out|Request timeout)\b|"(?:type|code)"\s*:\s*"(?:request_timeout|timeout_error)"/im.test(text)) {
    return {
      kind: 'timeout',
      message: 'The AI request for this review timed out. Retry when the provider is responsive; if this persists, an operator should check the request timeout and review scope.',
    };
  }

  if (/"type"\s*:\s*"overloaded_error"|^\s*API Error:\s*(?:500|502|503|504|529)\b/im.test(text)) {
    return {
      kind: 'provider_unavailable',
      message: 'The AI provider could not serve this review request. Retry after the provider recovers; if this persists, an operator should check provider availability.',
    };
  }

  return {
    kind: 'unknown',
    message: `The review process failed (exit ${exitCode}). An operator needs to inspect the captured harness diagnostics to identify the cause.`,
  };
}
