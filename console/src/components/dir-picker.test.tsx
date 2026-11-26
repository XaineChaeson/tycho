import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { DirPickerDialog, splitBreadcrumbs } from '@/components/dir-picker';
import { deferred, open, type Call } from '@/test/harness';

test('splitBreadcrumbs parses POSIX and Windows paths cleanly', () => {
  expect(splitBreadcrumbs('/home/lighthouse/app', 'linux')).toEqual([
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'lighthouse', path: '/home/lighthouse' },
    { label: 'app', path: '/home/lighthouse/app' },
  ]);
  expect(splitBreadcrumbs('D:\\code\\tycho', 'win32')).toEqual([
    { label: 'D:\\', path: 'D:\\' },
    { label: 'code', path: 'D:\\code' },
    { label: 'tycho', path: 'D:\\code\\tycho' },
  ]);
});

test('folder code source supports remote browsing, creating, renaming, and picking a directory', async () => {
  const dirs: Record<string, { name: string; path: string; kind: 'dir' | 'file'; is_git?: boolean }[]> = {
    '/home/me': [
      { name: 'existing-repo', path: '/home/me/existing-repo', kind: 'dir', is_git: true },
      { name: 'notes.txt', path: '/home/me/notes.txt', kind: 'file' },
    ],
    '/home/me/existing-repo': [
      { name: 'src', path: '/home/me/existing-repo/src', kind: 'dir' },
      { name: 'package.json', path: '/home/me/existing-repo/package.json', kind: 'file' },
    ],
  };

  const proj = {
    id: 'p1', name: '演示项目', archived: false,
    sources: [{ id: 's1', kind: 'folder', machine_uid: 'uid-m1', path: '', default: true, label: '' }],
    logins: [], login_mode: 'all', machines: [], spawn_machines: false,
    grants: [], router: { account: null, tier: null },
  };

  open('#/projects/p1/settings', (call: Call) => {
    const url = new URL(call.path, 'http://localhost');
    if (url.pathname === '/api/projects') return { projects: [proj] };
    if (url.pathname === '/api/projects/p1') return { project: proj };
    if (url.pathname === '/api/accounts') {
      return {
        accounts: [],
        tier_forms: {}, permission_modes: {}, account_logins: {}, provider_forms: {}, dispatch_order: {},
      };
    }
    if (url.pathname === '/api/machines') {
      return {
        machines: [{ id: 'linux-worker-01', uid: 'uid-m1', node: { connected: true }, logins: [] }],
        invites: [],
      };
    }
    if (call.method === 'GET' && url.pathname === '/api/machines/uid-m1/dirs') {
      const p = url.searchParams.get('path') || '/home/me';
      const parent = p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/';
      return { path: p, parent, home: '/home/me', roots: ['/'], platform: 'linux', entries: dirs[p] ?? [] };
    }
    if (call.method === 'POST' && url.pathname === '/api/machines/uid-m1/dirs') {
      const body = call.body as { parent: string; name: string };
      const createdPath = `${body.parent}/${body.name}`;
      dirs[body.parent] = [...(dirs[body.parent] ?? []), { name: body.name, path: createdPath, kind: 'dir' }];
      dirs[createdPath] = [];
      return { path: createdPath, name: body.name };
    }
    if (call.method === 'PUT' && url.pathname === '/api/machines/uid-m1/dirs') {
      const body = call.body as { path: string; name: string };
      const parent = body.path.slice(0, body.path.lastIndexOf('/'));
      const nextPath = `${parent}/${body.name}`;
      dirs[parent] = (dirs[parent] ?? []).map((e) => (e.path === body.path ? { ...e, name: body.name, path: nextPath } : e));
      dirs[nextPath] = dirs[body.path] ?? [];
      delete dirs[body.path];
      return { path: nextPath, name: body.name };
    }
    return undefined;
  });

  const browseBtn = await screen.findByRole('button', { name: '浏览第 1 个来源的文件夹' });
  await waitFor(() => expect(browseBtn).toBeEnabled());
  fireEvent.click(browseBtn);

  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('existing-repo')).toBeInTheDocument();
  expect(within(dialog).getByText('git')).toBeInTheDocument();
  expect(within(dialog).getByText('notes.txt')).toBeInTheDocument();

  // Create a new folder and confirm the picker auto-navigates into it
  fireEvent.click(within(dialog).getByRole('button', { name: '新建文件夹' }));
  fireEvent.change(within(dialog).getByLabelText('新文件夹名称'), { target: { value: 'brand-new' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

  await waitFor(() => {
    expect(within(dialog).getByText('这个文件夹是空的，可直接选择当前目录或新建子文件夹。')).toBeInTheDocument();
  });

  // Go up and rename the newly created folder
  fireEvent.click(within(dialog).getByRole('button', { name: '返回上一级' }));
  const renameTrigger = await within(dialog).findByRole('button', { name: '重命名 brand-new' });
  fireEvent.click(renameTrigger);
  fireEvent.change(within(dialog).getByLabelText('重命名文件夹'), { target: { value: 'fresh-app' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认重命名' }));

  const renamedBtn = await within(dialog).findByRole('button', { name: 'fresh-app' });
  fireEvent.click(renamedBtn);
  await waitFor(() => {
    expect(within(dialog).getByText('/home/me/fresh-app')).toBeInTheDocument();
  });

  // Select the folder and verify it fills the folder path input
  fireEvent.click(within(dialog).getByRole('button', { name: '选择当前目录' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(screen.getByLabelText('第 1 个来源的文件夹')).toHaveValue('/home/me/fresh-app');
});

test('toggling showHidden reloads the current navigated directory instead of resetting to initialPath', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const raw = String(input);
    requests.push(raw);
    const url = new URL(raw, 'http://localhost');
    const p = url.searchParams.get('path') || '/home/me';
    const hidden = url.searchParams.get('show_hidden') === '1';
    const entries = p === '/home/me'
      ? [{ name: 'sub', path: '/home/me/sub', kind: 'dir' }]
      : [
          { name: 'app', path: '/home/me/sub/app', kind: 'dir' },
          ...(hidden ? [{ name: '.env', path: '/home/me/sub/.env', kind: 'file' }] : []),
        ];
    return {
      ok: true,
      status: 200,
      json: async () => ({ path: p, parent: p === '/home/me' ? '/home' : '/home/me', home: '/home/me', roots: ['/'], platform: 'linux', entries }),
    };
  }));

  render(
    <DirPickerDialog
      open
      machineUid="uid-m1"
      machineName="box"
      initialPath="/home/me"
      onSelect={() => undefined}
      onOpenChange={() => undefined}
    />,
  );

  const dialog = await screen.findByRole('dialog');
  fireEvent.click(await within(dialog).findByRole('button', { name: 'sub' }));
  expect(await within(dialog).findByText('/home/me/sub')).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole('checkbox', { name: '显示隐藏项' }));
  expect(await within(dialog).findByText('.env')).toBeInTheDocument();
  expect(within(dialog).getByText('/home/me/sub')).toBeInTheDocument();
  expect(requests.at(-1)).toContain('path=%2Fhome%2Fme%2Fsub');
  expect(requests.at(-1)).toContain('show_hidden=1');
});

test('stale slow directory responses are discarded and never overwrite newer navigation', async () => {
  const slowFirst = deferred<{ path: string; parent: string; home: string; roots: string[]; platform: string; entries: { name: string; path: string; kind: 'dir' | 'file' }[] }>();
  const fastSecond = deferred<{ path: string; parent: string; home: string; roots: string[]; platform: string; entries: { name: string; path: string; kind: 'dir' | 'file' }[] }>();
  let callIndex = 0;

  vi.stubGlobal('fetch', vi.fn(async () => {
    callIndex += 1;
    const data = callIndex === 1 ? await slowFirst.promise : await fastSecond.promise;
    return { ok: true, status: 200, json: async () => data };
  }));

  const { rerender } = render(
    <DirPickerDialog
      open
      machineUid="uid-m1"
      machineName="box"
      initialPath="/home/slow"
      onSelect={() => undefined}
      onOpenChange={() => undefined}
    />,
  );

  // Trigger a second newer load before the first one finishes
  rerender(
    <DirPickerDialog
      open
      machineUid="uid-m1"
      machineName="box"
      initialPath="/home/fast"
      onSelect={() => undefined}
      onOpenChange={() => undefined}
    />,
  );

  await act(async () => {
    fastSecond.resolve({
      path: '/home/fast',
      parent: '/home',
      home: '/home',
      roots: ['/'],
      platform: 'linux',
      entries: [{ name: 'fresh-dir', path: '/home/fast/fresh-dir', kind: 'dir' }],
    });
  });

  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('fresh-dir')).toBeInTheDocument();
  expect(within(dialog).getByText('/home/fast')).toBeInTheDocument();

  // Now the stale earlier response arrives; it must be ignored.
  await act(async () => {
    slowFirst.resolve({
      path: '/home/slow',
      parent: '/home',
      home: '/home',
      roots: ['/'],
      platform: 'linux',
      entries: [{ name: 'stale-dir', path: '/home/slow/stale-dir', kind: 'dir' }],
    });
  });

  expect(within(dialog).getByText('fresh-dir')).toBeInTheDocument();
  expect(within(dialog).queryByText('stale-dir')).toBeNull();
  expect(within(dialog).getByText('/home/fast')).toBeInTheDocument();
});
