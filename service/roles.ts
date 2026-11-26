// Roles are objects the owner adds, changes and removes in the console
// (docs/design/roles-and-tiers.md §3). The ledger keeps them; this is what decides a valid
// one — the review role's shape included — and what the tools and the pages ask for a role,
// at each use.
import {
  DELIVERABLES, isDeliverableId, isPermissionId, PERMISSIONS, REVIEW_KEEP_TEXT, REVIEW_ROLE_ID,
  type RoleConfig,
} from '../shared/roles.ts';
import { isTierId, tierNamesText } from '../shared/tiers.ts';
import { InputError } from './errors.ts';
import type { Ctx, Ledger, RoleRecord } from './ledger.ts';

const ROLE_ID = /^[A-Za-z0-9][\w-]{0,31}$/;

// A role as someone wrote it in the console. Every field is a claim until checked.
export interface RoleInput {
  name?: unknown;
  description?: unknown;
  defaultTier?: unknown;
  permission?: unknown;
  deliverable?: unknown;
  needsReview?: unknown;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InputError(`${what}不能为空`);
  return value.trim();
}

function checkRole(id: string, input: RoleInput): RoleConfig {
  if (!ROLE_ID.test(id)) throw new InputError(`职能的标识 ${id} 不能用：只能有字母、数字、_ 和 -，以字母或数字开头，最多 32 个字`);
  const name = text(input.name, '职能名');
  if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
    throw new InputError('职能说明要是文字');
  }
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (typeof input.defaultTier !== 'string' || !isTierId(input.defaultTier)) throw new InputError(`默认档位只能是${tierNamesText}之一`);
  if (!isPermissionId(input.permission)) throw new InputError(`权限只能是${PERMISSIONS.map((each) => each.label).join('、')}之一`);
  if (!isDeliverableId(input.deliverable)) throw new InputError(`交付物只能是${DELIVERABLES.map((each) => each.label).join('、')}之一`);
  if (input.needsReview !== undefined && typeof input.needsReview !== 'boolean') throw new InputError('“要独立审阅”要是开或关');
  return {
    id, name, description, default_tier: input.defaultTier, permission: input.permission, deliverable: input.deliverable, needs_review: input.needsReview ?? false,
  };
}

export function createRoles({ ledger }: { ledger: Pick<Ledger, 'getRole' | 'listRoles' | 'putRole' | 'deleteRole'> }) {
  return {
    get: (id: string): RoleRecord | undefined => ledger.getRole(id),
    list: (): RoleRecord[] => ledger.listRoles(),
    put(id: string, input: RoleInput, ctx: Ctx): { role: RoleRecord; created: boolean; changed?: Record<string, { from: unknown; to: unknown }> } {
      const { created, changed } = ledger.putRole(checkRole(id, input), ctx);
      return { role: ledger.getRole(id)!, created, ...(changed ? { changed } : {}) };
    },
    remove(id: string, ctx: Ctx): void {
      if (id === REVIEW_ROLE_ID) throw new InputError(REVIEW_KEEP_TEXT);
      ledger.deleteRole(id, ctx);
    },
  };
}

export type Roles = ReturnType<typeof createRoles>;

// Knowledge tasks are no longer locked to read-only roles.
export function knowledgeRoleRefusal(_role: { name: string; permission: string } | undefined): string | undefined {
  return undefined;
}
