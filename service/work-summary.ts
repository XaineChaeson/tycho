interface SummaryTask {
  id: string;
  parent_id: string | null;
  state: string;
  closed_at?: string | null;
  review_of_json?: string | null;
  verdict_json?: string | null;
}
interface SummaryApproval { task_id: string; state: string }

export interface WorkSummary {
  dot: string;
  text: string;
  counts: Record<string, number>;
  // No descendants: the pages show the task's own state and reason instead of counts.
  leaf: boolean;
  // When the last of an ended work ended (`dot` is 'done'); null while any of it goes on.
  ended_at: string | null;
}

function reviewTargetOf(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { task_id?: unknown } | null;
    return typeof parsed?.task_id === 'string' && parsed.task_id !== '' ? parsed.task_id : null;
  } catch {
    return null;
  }
}

function verdictResultOf(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { result?: unknown } | null;
    return typeof parsed?.result === 'string' ? parsed.result : null;
  } catch {
    return null;
  }
}

// Draft containers do not compete with the work represented by their descendants.
export function summarizeWork(taskId: string, tasks: readonly SummaryTask[], approvals: readonly SummaryApproval[]): WorkSummary {
  return workSummaries(tasks, approvals)(taskId);
}

// The same for many works over one reading of the ledger: the tree is indexed once, so a
// listing of every work costs what the tasks number, not its square.
export function workSummaries(tasks: readonly SummaryTask[], approvals: readonly SummaryApproval[]): (taskId: string) => WorkSummary {
  const children = new Map<string, SummaryTask[]>();
  for (const task of tasks) {
    if (!task.parent_id) continue;
    const siblings = children.get(task.parent_id);
    if (siblings) siblings.push(task);
    else children.set(task.parent_id, [task]);
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const openApprovals = new Map<string, number>();
  for (const approval of approvals) if (approval.state === 'open') openApprovals.set(approval.task_id, (openApprovals.get(approval.task_id) ?? 0) + 1);
  const activeReviewByTarget = new Map<string, SummaryTask>();
  for (const task of tasks) {
    const targetId = reviewTargetOf(task.review_of_json);
    if (targetId === null) continue;
    const verdict = verdictResultOf(task.verdict_json);
    if (task.state === 'done' || task.state === 'abandoned' || (task.state === 'ready' && (verdict === 'pass' || verdict === 'reject'))) {
      if (verdict === 'pass') activeReviewByTarget.delete(targetId);
      continue;
    }
    activeReviewByTarget.set(targetId, task);
  }

  return (taskId) => {
    const root = byId.get(taskId);
    const tree: SummaryTask[] = root ? [root] : [];
    for (let i = 0; i < tree.length; i += 1) tree.push(...(children.get(tree[i]!.id) ?? []));
    const counts: Record<string, number> = {};
    let open = 0;
    let endedAt: string | null = null;
    for (const task of tree) {
      open += openApprovals.get(task.id) ?? 0;
      if (task.closed_at && (endedAt === null || task.closed_at > endedAt)) endedAt = task.closed_at;
      if (task.state === 'draft' && children.has(task.id)) continue;
      if (task.state === 'ready') {
        const review = activeReviewByTarget.get(task.id);
        if (review !== undefined) {
          const stuck = review.state === 'held' || review.state === 'waiting_person' || (openApprovals.get(review.id) ?? 0) > 0;
          const effective = stuck ? 'review_held' : 'in_review';
          counts[effective] = (counts[effective] ?? 0) + 1;
          continue;
        }
      }
      counts[task.state] = (counts[task.state] ?? 0) + 1;
    }
    const leaf = tree.length <= 1;
    const waiting = Math.max(counts.waiting_person ?? 0, open);
    const moving = ['running', 'launching', 'stopping', 'queued'].reduce((n, state) => n + (counts[state] ?? 0), 0);
    const inReview = counts.in_review ?? 0;
    const reviewHeld = counts.review_held ?? 0;
    // A machine out of contact is work in progress: the rules judge it and continue it.
    // It shows as itself only when nothing else of the work is moving.
    const dot = waiting ? 'waiting_person' : (moving || inReview) ? 'running' : counts.needs_verification ? 'needs_verification'
      : counts.ready ? 'ready' : (counts.held || reviewHeld) ? 'held' : counts.waiting_timer ? 'waiting_timer'
        : counts.draft ? 'draft' : 'done';
    const parts = [
      moving && `${moving} 个在执行`,
      inReview && (leaf ? '审阅中' : `${inReview} 个审阅中`),
      counts.needs_verification && `${counts.needs_verification} 个执行机器失联`,
      counts.ready && `${counts.ready} 个待验收`,
      waiting && `${waiting} 个等你决定`,
      counts.held && `${counts.held} 个已停住`,
      reviewHeld && (leaf ? '审阅停住' : `${reviewHeld} 个审阅停住`),
      counts.waiting_timer && `${counts.waiting_timer} 个等预约`,
    ].filter(Boolean);
    return {
      dot,
      text: parts.join('，') || (dot === 'draft' ? '草稿' : '已结束'),
      counts,
      leaf,
      ended_at: dot === 'done' ? endedAt : null,
    };
  };
}
