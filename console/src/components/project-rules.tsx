// The rules every round of one project starts from: its own resident knowledge entries for any
// role, which are what Claude Code Projects calls project instructions. Not a second store: each
// row is the knowledge entry itself, new ones and edits go through the knowledge page's own form
// as the owner's change (in force at once), and the knowledge page stays where all of it lives.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Note, Problem, Rows } from '@/components/bits';
import { BLANK_CANDIDATE, OwnerChangeForm, draftOf, entryPath, ROW_LINK } from '@/components/knowledge-bits';
import { Button } from '@/components/ui/button';
import { messageOf } from '@/lib/api';
import { knowledgeQuery } from '@/lib/queries';
import type { KnowledgeEntry, Project } from '@/lib/types';

// Resident, for any role, in force, knowledge rather than a skill.
const standing = (entry: KnowledgeEntry): boolean =>
  entry.state === 'active' && entry.kind === 'knowledge' && entry.loading === 'resident' && entry.roles.length === 0;

export function ProjectRules({ project }: { project: Project }) {
  const { data, error } = useQuery(knowledgeQuery);
  const [writing, setWriting] = useState<KnowledgeEntry | 'new' | null>(null);
  const own = data?.entries.filter((entry) => standing(entry) && entry.project_ids?.includes(project.id)) ?? [];
  const global = data?.entries.filter((entry) => standing(entry) && entry.project_ids === null).length ?? 0;
  return (
    <>
      {error ? <Problem>{`知识读不到：${messageOf(error)}`}</Problem> : !data ? <Note>正在读……</Note> : own.length ? (
        <Rows>
          <ul aria-label={`${project.name} 的常驻规则`} className="divide-y divide-border">
            {own.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 pr-2">
                <Link to={entryPath(entry.id)} className={`${ROW_LINK} min-w-0 flex-1`}>
                  <span className="block truncate font-medium">{entry.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{entry.when_to_use}</span>
                </Link>
                <Button size="sm" variant="ghost" aria-label={`修改 ${entry.title}`} onClick={() => setWriting(entry)}>修改</Button>
              </li>
            ))}
          </ul>
        </Rows>
      ) : <Note>还没有只属于这个项目的常驻规则。</Note>}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button disabled={!data} onClick={() => setWriting('new')}>新建规则</Button>
        {global ? <Note className="text-xs">另有 {global} 条全局常驻的也适用，在<Link to="/knowledge" className="mx-0.5">知识</Link>页。</Note> : null}
      </div>
      {data && writing === 'new' ? (
        <OwnerChangeForm
          label="新建这个项目的规则"
          lead="这个项目的每一轮和它的负责人都会带上全文。你自己写的不用把关，保存就直接生效，算已审阅。"
          names={data}
          initial={{ ...BLANK_CANDIDATE, scope: 'projects', projects: [project.id], loading: 'resident' }}
          wrap={(output) => ({ outputs: [output] })}
          onSaved={() => setWriting(null)}
          onClose={() => setWriting(null)}
        />
      ) : null}
      {data && writing !== null && writing !== 'new' ? (
        <OwnerChangeForm
          label={`修改 ${writing.title}`}
          lead="改完就是这一条的新修订，直接生效，算已审阅。"
          names={data}
          initial={draftOf(writing, writing.kind)}
          edits
          // A revision of the revision on the page: one published meanwhile is refused.
          wrap={(output) => ({ inputs: [{ knowledge_id: writing.id, revision: writing.revision, disposition: 'revise' }], outputs: [{ revises: writing.id, ...output }] })}
          onSaved={() => setWriting(null)}
          onClose={() => setWriting(null)}
        />
      ) : null}
    </>
  );
}
