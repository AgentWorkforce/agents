// The manifest is declared in persona.ts: the launch page resolves that file
// statically and builds its constant scope from that file alone, so an
// imported identifier fails the whole resolve. Re-exported here so the handler
// and tests keep one import site.
import { ASKABLE_GTM_CAPABILITY } from './persona.js';

export { ASKABLE_GTM_CAPABILITY, type AskableAvailability } from './persona.js';

export type AskableGtmCapability = typeof ASKABLE_GTM_CAPABILITY;
