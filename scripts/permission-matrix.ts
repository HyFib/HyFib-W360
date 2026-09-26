// Prints the role → permission matrix as Markdown from the source of truth in @w360/domain.
// Usage: pnpm tsx scripts/permission-matrix.ts > /tmp/matrix.md
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  PRIVILEGED_ROLES,
  ALLOWED_WHEN_SUSPENDED,
} from '../packages/domain/src/authz/permissions';
import { TENANT_ROLES } from '../packages/db/src/schema/tenancy';

const header = `| Permission | ${TENANT_ROLES.join(' | ')} | Allowed while suspended |`;
const sep = `|---|${TENANT_ROLES.map(() => ':-:').join('|')}|:-:|`;
const rows = PERMISSIONS.map(
  (p) =>
    `| \`${p}\` | ${TENANT_ROLES.map((r) => (ROLE_PERMISSIONS[r].has(p) ? '✓' : '')).join(' | ')} | ${ALLOWED_WHEN_SUSPENDED.has(p) ? '✓' : ''} |`,
);
process.stdout.write(
  [
    header,
    sep,
    ...rows,
    '',
    `MFA required (after grace period): ${[...PRIVILEGED_ROLES].join(', ')}.`,
    '',
  ].join('\n'),
);
