// What a project lets its Router do without asking (docs/design/project-sessions.md §6), declared
// once for the service and the console. Each is a step the owner can always take from the console;
// a grant only says whether the Router may take it too. The gates in front of each step (review,
// acceptance, the release gate) stay where they are and apply to the Router as to anyone: a grant
// never opens a gate, it only removes the question. What is done under a grant reaches the owner as
// the service's own result push, not in the Router's words.

export const GRANT_IDS = ['accept', 'integrate', 'release'] as const;
export type GrantId = (typeof GRANT_IDS)[number];

export interface GrantSpec {
  label: string;
  // What it lets the Router do, and what has to hold first, in the owner's words.
  hint: string;
  // What a project starts with. Comparable agents land work on their own branch and leave the main
  // line and deployment to a person; accepting is what the Router could always do.
  on: boolean;
}

export const GRANTS: Record<GrantId, GrantSpec> = {
  accept: {
    label: '验收',
    hint: '审阅通过（职能要审阅的）后由负责人直接验收，取回产物。',
    on: true,
  },
  integrate: {
    label: '并入主线',
    hint: '已验收任务的代码由负责人合入：派执行器在代码托管平台上合那一轮开的 PR，只合审过的那个提交，平台的分支保护照旧。',
    on: false,
  },
  release: {
    label: '上线',
    hint: '已验收任务的发布包由负责人上线，和控制台的上线走同一道关：当前产物要有审阅通过。',
    on: false,
  },
};

export const isGrantId = (id: unknown): id is GrantId => typeof id === 'string' && (GRANT_IDS as readonly string[]).includes(id);

export const DEFAULT_GRANTS: GrantId[] = GRANT_IDS.filter((id) => GRANTS[id].on);

// A stored list as the vocabulary has it now: unknown ids (a grant since removed) mean nothing.
export const grantsOf = (stored: string): GrantId[] => {
  const parsed = JSON.parse(stored) as unknown;
  return Array.isArray(parsed) ? GRANT_IDS.filter((id) => parsed.includes(id)) : [];
};

// The Router's refusal when a step is not granted: the owner takes it from the console.
export const notGrantedText = (id: GrantId): string =>
  `这个项目没有授权负责人自己${GRANTS[id].label}：告诉主人这一步等他在任务页做，或者请他在项目设置里打开“${GRANTS[id].label}”。`;
