/**
 * Validates a team spec object against the cloud TeamSpec contract.
 *
 * Mirrors the rules enforced by cloud's `loadTeamSpec`
 * (packages/core/src/proactive-runtime/team-spec.ts) plus the Phase-1
 * `bindTeam` restrictions (packages/web/lib/proactive-runtime/team-deploy.ts):
 *
 *  - `id`, `lead` are non-empty strings; `id` must match the team directory.
 *  - `members` is a non-empty array of { name, persona, role?, owns? } with
 *    unique names.
 *  - A persona ref is a non-empty string slug, or an object carrying at least
 *    one of `slug` / `path` / `inline`. Phase-1 binding rejects `inline`, so
 *    we do too.
 *  - No `owns` selector may be claimed by two different members.
 *  - `tokenBudget` / `timeBudgetSeconds` are positive 32-bit integers.
 *
 * Returns an array of human-readable error strings; empty means valid.
 */

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Order-independent key for an owns selector, matching cloud's stableJson so
// the double-claim check agrees with what bindTeam would reject.
function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInt32(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= POSTGRES_INTEGER_MAX
  );
}

function validatePersonaRef(value, path, errors) {
  if (typeof value === 'string') {
    if (!nonEmptyString(value)) {
      errors.push(`${path} must be a non-empty string`);
    }
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${path} must be a string or object`);
    return;
  }
  if (value.slug !== undefined && !nonEmptyString(value.slug)) {
    errors.push(`${path}.slug must be a non-empty string`);
  }
  if (value.path !== undefined && !nonEmptyString(value.path)) {
    errors.push(`${path}.path must be a non-empty string`);
  }
  if (value.version !== undefined) {
    const versionOk =
      (typeof value.version === 'string' && nonEmptyString(value.version)) ||
      (typeof value.version === 'number' &&
        Number.isInteger(value.version) &&
        value.version > 0);
    if (!versionOk) {
      errors.push(`${path}.version must be a non-empty string or positive integer`);
    }
  }
  if (value.inline !== undefined) {
    // loadTeamSpec accepts inline refs, but Phase-1 bindTeam rejects them
    // ("deploy the persona first and reference it by slug or path"), so a
    // checked-in spec with an inline ref could never bind.
    errors.push(`${path}.inline is not supported by Phase-1 team binding`);
    return;
  }
  if (value.slug === undefined && value.path === undefined) {
    errors.push(`${path} must include slug or path`);
  }
}

export function validateTeamSpec(spec, { expectedId } = {}) {
  const errors = [];
  if (!isRecord(spec)) {
    return ['team spec must be an object'];
  }

  if (!nonEmptyString(spec.id)) {
    errors.push('id must be a non-empty string');
  } else if (expectedId !== undefined && spec.id !== expectedId) {
    errors.push(`id "${spec.id}" must match team directory "${expectedId}"`);
  }

  if (!nonEmptyString(spec.lead)) {
    errors.push('lead must be a non-empty string');
  }

  if (!Array.isArray(spec.members) || spec.members.length === 0) {
    errors.push('members must be a non-empty array');
    return errors;
  }

  const names = new Set();
  const ownedSelectors = new Map();
  spec.members.forEach((member, index) => {
    const path = `members[${index}]`;
    if (!isRecord(member)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!nonEmptyString(member.name)) {
      errors.push(`${path}.name must be a non-empty string`);
    } else if (names.has(member.name)) {
      errors.push(`duplicate member name "${member.name}"`);
    } else {
      names.add(member.name);
    }
    validatePersonaRef(member.persona, `${path}.persona`, errors);
    if (member.role !== undefined && !nonEmptyString(member.role)) {
      errors.push(`${path}.role must be a non-empty string`);
    }
    if (member.owns !== undefined) {
      if (!Array.isArray(member.owns)) {
        errors.push(`${path}.owns must be an array`);
      } else {
        member.owns.forEach((selector, selectorIndex) => {
          if (!isRecord(selector)) {
            errors.push(`${path}.owns[${selectorIndex}] must be an object`);
            return;
          }
          const key = stableJson(selector);
          const existingOwner = ownedSelectors.get(key);
          if (existingOwner && existingOwner !== member.name) {
            errors.push(
              `owns selector ${key} is claimed by both "${existingOwner}" and "${member.name}"`,
            );
          }
          ownedSelectors.set(key, member.name);
        });
      }
    }
  });

  if (spec.delegation !== undefined) {
    if (!Array.isArray(spec.delegation)) {
      errors.push('delegation must be an array');
    } else {
      spec.delegation.forEach((rule, index) => {
        if (!isRecord(rule)) {
          errors.push(`delegation[${index}] must be an object`);
        }
      });
    }
  }
  if (spec.tokenBudget !== undefined && !positiveInt32(spec.tokenBudget)) {
    errors.push('tokenBudget must be a positive 32-bit integer');
  }
  if (spec.timeBudgetSeconds !== undefined && !positiveInt32(spec.timeBudgetSeconds)) {
    errors.push('timeBudgetSeconds must be a positive 32-bit integer');
  }

  return errors;
}
