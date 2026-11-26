// Guards the roles page against: a role shown without its default tier, permission,
// deliverable or review flag; a save that sends only part of a role (the service takes it
// whole); a new role saved under an id that is taken, which would change that role instead;
// the review role's permission or deliverable offered for change, or offered for deletion;
// the review role not saying that its tier follows the reviewed round, and that its default
// stays only for old bindings;
// a delete sent before it was confirmed; a refused save or delete that loses the edit or
// says nothing of why; a page that offers a save when nothing moved; and a page that lets
// the owner read permission and review as already enforced, when this step only records them.
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ENFORCED_TEXT, PRESET_ROLES, REVIEW_KEEP_TEXT, REVIEW_SHAPE_TEXT, REVIEW_TIER_TEXT } from '@shared/roles.ts';
import { TIERS } from '@shared/tiers.ts';
import { holdClock, open, pass, refusal, type Call, type Handler } from '@/test/harness';

const AT = '2026-11-05T00:00:00Z';
const PRESETS = PRESET_ROLES.map((role) => ({ ...role, created_at: AT, updated_at: AT }));

function listed(initial: object[] = PRESETS, answer: Handler = () => undefined): { handler: Handler; calls: Call[] } {
  let roles = [...initial] as { id: string }[];
  const calls: Call[] = [];
  const handler: Handler = (call) => {
    if (call.method === 'GET' && call.path === '/api/roles') return { roles };
    if (call.method === 'GET') return undefined;
    calls.push(call);
    const special = answer(call);
    if (special !== undefined) return special;
    const id = decodeURIComponent(call.path.split('/').at(-1)!);
    if (call.method === 'DELETE') { roles = roles.filter((each) => each.id !== id); return { deleted: true }; }
    const role = { id, ...(call.body as object), created_at: AT, updated_at: AT };
    const created = !roles.some((each) => each.id === id);
    roles = created ? [...roles, role] : roles.map((each) => (each.id === id ? role : each));
    return { role, created };
  };
  return { handler, calls };
}

const rail = () => screen.findByRole('complementary', { name: '职能列表' });
const card = (name: string) => screen.findByRole('region', { name: `职能 ${name}` });
const selectRole = async (user: ReturnType<typeof open>['user'], name: string) => {
  await user.click(await within(await rail()).findByRole('button', { name: `选择职能 ${name}` }));
  return card(name);
};
// A new role is written in a drawer beside the page.
const drawer = (name: string) => screen.findByRole('dialog', { name });
// Deleting asks once more, in a window of its own.
const confirmation = () => screen.findByRole('alertdialog');

test('every role is listed with what it is for, its default tier, what it may do, what it hands over and whether it is reviewed', async () => {
  const { user } = open('#/roles', listed().handler);
  const list = await rail();
  expect(within(list).getAllByRole('button', { name: /^选择职能 / })).toHaveLength(5);
  const implement = await card('实现');
  expect(implement).toHaveTextContent('implement');
  expect(implement).toHaveTextContent('改代码、写测试并交付提交。');
  expect(implement).toHaveTextContent('默认 执行档');
  expect(implement).toHaveTextContent('可写');
  expect(implement).toHaveTextContent('交付提交');
  expect(implement).toHaveTextContent('要独立审阅');
  const analyse = await selectRole(user, '分析');
  expect(analyse).toHaveTextContent('默认 决策档');
  expect(analyse).toHaveTextContent('只读');
  expect(analyse).toHaveTextContent('交付报告');
  expect(analyse).toHaveTextContent('不用独立审阅');
  expect(screen.getByRole('heading', { name: '职能', level: 1 })).toBeInTheDocument();
  // Permission and review are recorded, not yet enforced, and the page says so.
  expect(screen.getByText(ENFORCED_TEXT)).toBeInTheDocument();
});

test('a role is changed and the save sends the whole of it', async () => {
  const { handler, calls } = listed();
  const { user } = open('#/roles', handler);
  const verify = await selectRole(user, '验证');
  // Every tier is on offer, the operate tier among them, in their one order.
  expect([...(within(verify).getByRole('combobox', { name: '默认档位' }) as HTMLSelectElement).options].map(({ value, textContent }) => [value, textContent]))
    .toEqual(TIERS.map((tier) => [tier.id, tier.label]));
  expect(within(verify).getByRole('button', { name: '保存' }), '没改什么就没有可存的').toBeDisabled();
  await user.selectOptions(within(verify).getByRole('combobox', { name: '默认档位' }), 'decide');
  await user.click(within(verify).getByRole('switch', { name: '要独立审阅' }));
  await user.click(within(verify).getByRole('button', { name: '保存' }));
  const preset = PRESET_ROLES.find((role) => role.id === 'verify')!;
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/roles/verify', method: 'PUT',
    body: { name: '验证', description: preset.description, default_tier: 'decide', permission: 'write', deliverable: 'report', needs_review: true },
  }]));
  await waitFor(() => expect(within(verify).getByText('默认 决策档')).toBeInTheDocument());
  expect(verify).toHaveTextContent('要独立审阅');
  // Saved, there is nothing unsaved left to submit.
  await waitFor(() => expect(within(verify).getByRole('button', { name: '保存' })).toBeDisabled());
});

test('a role is added under the id typed, and an id that is taken is not saved over', async () => {
  const { handler, calls } = listed();
  const { user } = open('#/roles', handler);
  await card('实现');
  await user.click(screen.getByRole('button', { name: '加一个职能' }));
  const form = await drawer('新职能');
  await user.type(within(form).getByRole('textbox', { name: '标识' }), 'implement');
  await user.type(within(form).getByRole('textbox', { name: '名字' }), '设计');
  expect(form).toHaveTextContent('已经有标识为 implement 的职能（实现）');
  expect(within(form).getByRole('button', { name: '加上' })).toBeDisabled();
  await user.clear(within(form).getByRole('textbox', { name: '标识' }));
  await user.type(within(form).getByRole('textbox', { name: '标识' }), 'design');
  await user.type(within(form).getByRole('textbox', { name: '说明' }), '定方案，交报告');
  await user.click(within(form).getByRole('button', { name: '加上' }));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/roles/design', method: 'PUT',
    body: { name: '设计', description: '定方案，交报告', default_tier: 'decide', permission: 'read', deliverable: 'report', needs_review: false },
  }]));
  const design = await card('设计');
  expect(design).toHaveTextContent('design');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '新职能' })).toBeNull());
});

test('a role is deleted only once it is confirmed, and 取消 takes it back', async () => {
  const { handler, calls } = listed();
  const { user } = open('#/roles', handler);
  const analyse = await selectRole(user, '分析');
  await user.click(within(analyse).getByRole('button', { name: '删除' }));
  const asked = await confirmation();
  expect(asked).toHaveTextContent('删除职能 分析？');
  expect(calls).toEqual([]);
  await user.click(within(asked).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(calls).toEqual([]);
  await user.click(within(analyse).getByRole('button', { name: '删除' }));
  await user.click(within(await confirmation()).getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '职能 分析' })).toBeNull());
  expect(within(await rail()).queryByRole('button', { name: '选择职能 分析' })).toBeNull();
  expect(calls).toEqual([{ path: '/api/roles/analyse', method: 'DELETE', body: undefined }]);
});

test('the review role cannot be deleted, and its permission and deliverable cannot be changed', async () => {
  const { handler, calls } = listed();
  const { user } = open('#/roles', handler);
  const review = await selectRole(user, '审阅');
  expect(within(review).queryByRole('button', { name: '删除' })).toBeNull();
  expect(review).toHaveTextContent(REVIEW_KEEP_TEXT);
  // The review's own tier is the reviewed round's; the default stays only for old bindings.
  expect(review).toHaveTextContent(REVIEW_TIER_TEXT);
  expect(within(review).getByRole('combobox', { name: '权限' })).toBeDisabled();
  expect(within(review).getByRole('combobox', { name: '交付物' })).toBeDisabled();
  expect(review).toHaveTextContent(REVIEW_SHAPE_TEXT);
  // Its name and the rest are the owner's.
  await user.clear(within(review).getByRole('textbox', { name: '名字' }));
  await user.type(within(review).getByRole('textbox', { name: '名字' }), '复核');
  await user.click(within(review).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.body).toMatchObject({ name: '复核', permission: 'read', deliverable: 'verdict' });
  await card('复核');
  // Any other role's shape is open to change.
  const implement = await selectRole(user, '实现');
  expect(within(implement).getByRole('combobox', { name: '权限' })).toBeEnabled();
  expect(implement).not.toHaveTextContent(REVIEW_SHAPE_TEXT);
});

test('a refused save keeps the edit and says why in the service\'s words, and a refused delete keeps the role', async () => {
  const { handler } = listed(PRESETS, (call) => {
    if (call.method === 'PUT') throw refusal('已经有叫 分析 的职能');
    if (call.method === 'DELETE') throw refusal('还有 2 个没结束的任务用着这个职能');
    return undefined;
  });
  const { user } = open('#/roles', handler);
  const verify = await selectRole(user, '验证');
  await user.clear(within(verify).getByRole('textbox', { name: '名字' }));
  await user.type(within(verify).getByRole('textbox', { name: '名字' }), '分析');
  await user.click(within(verify).getByRole('button', { name: '保存' }));
  expect(await within(verify).findByRole('alert')).toHaveTextContent('已经有叫 分析 的职能');
  expect(within(verify).getByRole('textbox', { name: '名字' })).toHaveValue('分析');
  await user.click(within(verify).getByRole('button', { name: '取消' }));
  expect(within(verify).queryByRole('alert')).toBeNull();
  expect(within(verify).getByRole('textbox', { name: '名字' })).toHaveValue('验证');

  const implement = await selectRole(user, '实现');
  await user.click(within(implement).getByRole('button', { name: '删除' }));
  const asked = await confirmation();
  await user.click(within(asked).getByRole('button', { name: '确认删除' }));
  // The reason is said where the next try is: in the window that asked.
  expect(await within(asked).findByRole('alert')).toHaveTextContent('还有 2 个没结束的任务用着这个职能');
  // Behind the window the page is out of reach, but the role is still on it.
  expect(screen.getByRole('region', { name: '职能 实现', hidden: true })).toBeInTheDocument();
});

test('a new role the service refuses stays open with what was typed and the reason', async () => {
  const { handler } = listed(PRESETS, (call) => {
    if (call.method === 'PUT') throw refusal('职能的标识只能用字母、数字、_ 和 -');
    return undefined;
  });
  const { user } = open('#/roles', handler);
  await card('实现');
  await user.click(screen.getByRole('button', { name: '加一个职能' }));
  const form = await drawer('新职能');
  await user.type(within(form).getByRole('textbox', { name: '标识' }), '设 计');
  await user.type(within(form).getByRole('textbox', { name: '名字' }), '设计');
  await user.click(within(form).getByRole('button', { name: '加上' }));
  expect(await within(form).findByRole('alert')).toHaveTextContent('职能的标识只能用字母、数字、_ 和 -');
  expect(within(form).getByRole('textbox', { name: '标识' })).toHaveValue('设 计');
});

test('nothing is sent until a new role has both an id and a name', async () => {
  holdClock();
  const { handler, calls } = listed();
  const { user } = open('#/roles', handler);
  await card('实现');
  await user.click(screen.getByRole('button', { name: '加一个职能' }));
  const form = await drawer('新职能');
  await user.type(within(form).getByRole('textbox', { name: '标识' }), 'design');
  expect(within(form).getByRole('button', { name: '加上' })).toBeDisabled();
  await user.click(within(form).getByRole('button', { name: '加上' }));
  await pass();
  expect(calls).toEqual([]);
});

test('keyboard ArrowDown and ArrowUp switch roles in the left rail', async () => {
  const { user } = open('#/roles', listed().handler);
  const firstBtn = within(await rail()).getByRole('button', { name: '选择职能 实现' });
  firstBtn.focus();
  expect(firstBtn).toHaveAttribute('aria-current', 'true');
  await user.keyboard('{ArrowDown}');
  expect(await card('审阅')).toBeInTheDocument();
  expect(within(await rail()).getByRole('button', { name: '选择职能 审阅' })).toHaveAttribute('aria-current', 'true');
  await user.keyboard('{ArrowUp}');
  expect(await card('实现')).toBeInTheDocument();
});

test('switching away from a role with unsaved edits asks for confirmation and preserves edits when cancelled', async () => {
  const confirm = vi.spyOn(window, 'confirm');
  const { user } = open('#/roles', listed().handler);
  const implement = await card('实现');
  await user.clear(within(implement).getByRole('textbox', { name: '名字' }));
  await user.type(within(implement).getByRole('textbox', { name: '名字' }), '代码实现');
  expect(within(await rail()).getByRole('button', { name: '选择职能 实现' }).querySelector('[data-slot="dirty-dot"]')).not.toBeNull();

  // Cancelling confirmation keeps the current role and its unsaved edits.
  confirm.mockReturnValueOnce(false);
  await user.click(within(await rail()).getByRole('button', { name: '选择职能 分析' }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('region', { name: '职能 实现' })).toBeInTheDocument();
  expect(within(implement).getByRole('textbox', { name: '名字' })).toHaveValue('代码实现');

  // Keyboard navigation is also guarded when dirty.
  confirm.mockReturnValueOnce(false);
  within(await rail()).getByRole('button', { name: '选择职能 实现' }).focus();
  await user.keyboard('{ArrowDown}');
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('region', { name: '职能 实现' })).toBeInTheDocument();

  // Confirming allows switching to the target role.
  confirm.mockReturnValueOnce(true);
  await user.click(within(await rail()).getByRole('button', { name: '选择职能 分析' }));
  expect(confirm).toHaveBeenCalledTimes(3);
  expect(await card('分析')).toBeInTheDocument();
  confirm.mockRestore();
});
