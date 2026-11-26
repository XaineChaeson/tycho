import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { expect, test } from 'vitest';
import {
  ComposerTriggerMenu,
  LARGE_PASTE_THRESHOLD,
  createPastedLogFile,
  detectComposerTrigger,
  replaceTriggerText,
  type ComposerTriggerController,
} from '@/components/composer-triggers';
import { serve, type Handler } from '@/test/harness';

function Harness({ projectId = 'p1', initial = '' }: { projectId?: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [submitted, setSubmitted] = useState<string[]>([]);
  const controller = useRef<ComposerTriggerController>({ open: false, handleKeyDown: () => false });

  return (
    <div className="relative">
      <ComposerTriggerMenu
        projectId={projectId}
        value={value}
        caret={caret}
        controllerRef={controller}
        onApply={(next, nextCaret) => {
          setValue(next);
          setCaret(nextCaret);
        }}
      />
      <textarea
        aria-label="测试输入框"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyDown={(event) => {
          if (controller.current.handleKeyDown(event)) return;
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            setSubmitted((prev) => [...prev, value]);
          }
        }}
      />
      <div data-testid="submitted">{submitted.join('|')}</div>
    </div>
  );
}

function mount(handler: Handler, initial = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  serve(handler);
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  );
  return { user, ...view };
}

test('detectComposerTrigger, replaceTriggerText, and createPastedLogFile helpers work cleanly', () => {
  expect(detectComposerTrigger('$dep', 4)).toEqual({ kind: '$', query: 'dep', start: 0, end: 4 });
  expect(detectComposerTrigger('请参考 @main', 9)).toEqual({ kind: '@', query: 'main', start: 4, end: 9 });
  expect(detectComposerTrigger('foo@bar', 7)).toBeNull();
  expect(detectComposerTrigger('/us', 3)).toEqual({ kind: '/', query: 'us', start: 0, end: 3 });

  const applied = replaceTriggerText('请用 $dep 处理', { kind: '$', query: 'dep', start: 3, end: 7 }, '$部署规范 ');
  expect(applied).toEqual({ text: '请用 $部署规范  处理', caret: 9 });

  expect(LARGE_PASTE_THRESHOLD).toBe(16 * 1024);
  const file = createPastedLogFile('line1\nline2');
  expect(file.name).toMatch(/^pasted-log-.*\.txt$/);
  expect(file.type).toBe('text/plain');
});

test('$ trigger lists project skills and supports ArrowDown + Enter selection without triggering send', async () => {
  const { user } = mount((call) => {
    if (call.path === '/api/knowledge') {
      return {
        entries: [
          { id: 's1', kind: 'skill', title: '前端验证', when_to_use: '构建后检查', state: 'active', project_ids: ['p1'] },
          { id: 's2', kind: 'skill', title: '发布流程', when_to_use: '上线时使用', state: 'active', project_ids: null },
          { id: 's3', kind: 'skill', title: '别的项目技能', when_to_use: 'x', state: 'active', project_ids: ['p2'] },
        ],
        directory_skills: [],
      };
    }
    return undefined;
  });

  const box = screen.getByRole('textbox', { name: '测试输入框' });
  await user.type(box, '$');
  const listbox = await screen.findByRole('listbox', { name: '引用项目技能' });
  expect(listbox).toHaveTextContent('前端验证');
  expect(listbox).toHaveTextContent('发布流程');
  expect(listbox).not.toHaveTextContent('别的项目技能');

  await user.keyboard('{ArrowDown}{Enter}');
  expect(box).toHaveValue('$发布流程 ');
  expect(screen.getByTestId('submitted')).toHaveTextContent('');
});

test('@ trigger filters files and tasks, and /usage inserts live account quota summary', async () => {
  const { user } = mount((call) => {
    if (call.path === '/api/projects/p1/files') {
      return {
        files: [
          { id: 'f1', project_id: 'p1', name: 'design-spec.md', mime: 'text/markdown', size: 2048, kind: 'doc', origin: 'owner', summary: null, message_id: null, created_at: '', updated_at: '', previewable: false, is_image: false },
        ],
      };
    }
    if (call.path === '/api/tasks?top=1') {
      return {
        tasks: [
          { id: 't1', project_id: 'p1', title: '重构分屏布局', state: 'running' },
        ],
        children: [],
      };
    }
    if (call.path === '/api/accounts') {
      return {
        accounts: [
          {
            id: 'a1',
            name: 'claude-main',
            executor: 'claude',
            queued_tasks: 0,
            status: { active_runs: 1, max_runs: 3, rest: null, usage: [{ window: 'five_hour', used: 0.25, resets_at: null, at: '2026-11-05T00:00:00Z' }] },
          },
        ],
      };
    }
    if (call.path === '/api/machines') {
      return { machines: [], invites: [] };
    }
    return undefined;
  });

  const box = screen.getByRole('textbox', { name: '测试输入框' });
  await user.type(box, '@design');
  const fileMenu = await screen.findByRole('listbox', { name: '引用文件或任务' });
  expect(fileMenu).toHaveTextContent('design-spec.md');
  await user.click(screen.getByRole('option', { name: /design-spec\.md/ }));
  expect(box).toHaveValue('@design-spec.md ');

  await user.clear(box);
  await user.type(box, '/us');
  await screen.findByRole('listbox', { name: '快捷命令' });
  await user.keyboard('{Enter}');
  expect((box as HTMLTextAreaElement).value).toContain('claude-main');
  expect((box as HTMLTextAreaElement).value).toContain('25%');

  // Escape dismisses open trigger menu without submitting; normal Enter sends when closed.
  await user.clear(box);
  await user.type(box, '/');
  expect(await screen.findByRole('listbox', { name: '快捷命令' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).toBeNull();
  // IME Enter never intercepts or submits.
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
  expect(screen.getByTestId('submitted')).toHaveTextContent('');
});
