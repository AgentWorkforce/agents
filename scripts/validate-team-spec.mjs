/**
 * Agents-side compatibility wrapper around the shared Compose TeamSpec
 * contract. The package is now the sole parser/validator authority.
 */

export {
  TEAM_SPEC_FILENAME,
  TEAM_SPEC_JSON_SCHEMA,
  TeamSpecError,
  findTeamSpecFromPersonaDir,
  loadTeamSpec,
  loadTeamSpecFile,
  loadTeamSpecFromPersonaDir,
  parseTeamSpecFile,
  validateTeamSpec,
} from '@agentworkforce/compose';
