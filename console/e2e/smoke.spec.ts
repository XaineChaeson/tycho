// Guards what unit tests cannot see: that the built console, served by the real service
// under its content policy, loads at all; that the pages talk to the real interfaces in
// the shapes they expect (sign in, send a message and get the Router's reply, read the
// overview, open a task, list the roles, change a setting, read how a machine joins, note a
// machine and set up the login signed in on it, add an account, make a project's
// trigger); and that at a phone's width no page scrolls sideways; and a signed-in phone can
// approve a new browser through the
// device drawer, inspect both sessions and revoke the new browser after confirmation
// without either the drawer or confirmation overflowing the viewport; and that the
// settings page's list of groups stays in sight however far a group's page is scrolled, at
// a desk's width and a phone's, and its search leads to an item in another group.
//
// The service is tests/console-stage.ts: a scratch data directory and a free port, the
// fake CLI as the Router. The browser is the Edge this machine already has; none is
// downloaded, and where there is no Edge the test says so and is skipped.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { NODE_PROTOCOL } from '../../shared/node-protocol.ts';

interface Stage {
  url: string;
  // The project whose conversation the smoke talks in (docs/design/project-sessions.md §1).
  project: string;
  login: string;
  work: string;
  reported: string;
  running: string;
  long: string;
}

// The stage holds text with nowhere to break in it: a branch for a title, a path in a
// reason, an option that is a whole sentence.
const LONG_TITLE = /feature\/console-frontend-rewrite/;

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 700 };

let service: ChildProcess | undefined;
let stage: Stage;
let browser: Browser | undefined;
let page: Page;
// Anything the page logs as an error: a blocked script or style would show here.
const problems: string[] = [];

async function startStage(): Promise<Stage> {
  const child = spawn(process.execPath, ['tests/console-stage.ts'], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
  service = child;
  // Its first line of JSON says where it listens; ending before that is a failed start.
  for await (const line of createInterface({ input: child.stdout! })) {
    if (line.startsWith('{')) return JSON.parse(line) as Stage;
  }
  throw new Error(`预置服务没有起来（退出码 ${child.exitCode}）`);
}

// The side column has three navs: the views, the projects, and what is set up. Names like
// "账号" or "机器" also name a settings group, and "项目" and "工作" name a tab of a project,
// so a click that means a place has to say which nav it means.
const views = () => page.getByRole('navigation', { name: '视图' });
const projectsNav = () => page.getByRole('navigation', { name: '项目' });
const setup = () => page.getByRole('navigation', { name: '配置' });
// The overview's entry carries how many things wait, so its name is more than "总览".
const overviewLink = () => views().getByRole('link', { name: /^总览/ });

const settingsOf = (name: string) => page.getByRole('article', { name: `项目 ${name}` });
const logins = (card: Locator) => card.getByRole('list', { name: '允许的登录' });
const save = (card: Locator) => card.getByRole('button', { name: '保存', exact: true });

// Every page of the console: a name for its picture, its address, and something that is
// on it once it has been read.
const pagesOf = (at: Stage): [string, string, (page: Page) => Locator][] => [
  ['overview', '#/', (view) => view.getByRole('main').getByRole('region', { name: '需要你处理' })],
  ['work-list', '#/work', (view) => view.getByRole('main').getByRole('link', { name: /发布新控制台/ })],
  ['work-ended', '#/work?show=ended', (view) => view.getByRole('search', { name: '筛选已结束的工作' })],
  ['usage', '#/usage', (view) => view.getByRole('heading', { name: '剩余额度' })],
  ['projects', '#/projects', (view) => view.getByRole('list', { name: '项目' }).getByRole('link', { name: '项目 试跑' })],
  ['project', `#/projects/${at.project}`, (view) => view.getByRole('textbox', { name: '给总控发消息' })],
  ['project-work', `#/projects/${at.project}/work`, (view) => view.getByRole('main').getByRole('link', { name: /发布新控制台/ })],
  ['project-triggers', `#/projects/${at.project}/triggers`, (view) => view.getByRole('region', { name: '试跑 的触发器' }).getByRole('button', { name: '新建触发器' })],
  ['project-settings', `#/projects/${at.project}/settings`, (view) => view.getByRole('article', { name: '项目 试跑' })],
  ['roles', '#/roles', (view) => view.getByRole('region', { name: '职能 审阅' })],
  ['knowledge', '#/knowledge', (view) => view.getByRole('navigation', { name: '知识的哪一部分' }).getByRole('link', { name: /^待处理/ })],
  ['knowledge-access', '#/knowledge?view=access', (view) => view.getByRole('region', { name: '知识 MCP 客户端' })],
  ['work', `#/work/${at.work}`, (view) => view.getByRole('heading', { name: '发布新控制台' })],
  ['task-reported', `#/task/${at.reported}`, (view) => view.getByRole('heading', { name: '汇报' })],
  ['task-running', `#/task/${at.running}`, (view) => view.getByRole('heading', { name: '修登录页的提示' })],
  ['work-long', `#/work/${at.long}`, (view) => view.getByRole('heading', { name: LONG_TITLE })],
  ['task-long', `#/task/${at.long}`, (view) => view.getByRole('heading', { name: LONG_TITLE })],
  ['settings', '#/settings', (view) => view.getByRole('region', { name: '总控' })],
  ['accounts', '#/accounts', (view) => view.getByRole('heading', { level: 1, name: '账号' })],
  ['machines', '#/machines', (view) => view.getByRole('heading', { level: 1, name: '机器' })],
];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  try {
    browser = await playwright.chromium.launch({ channel: 'msedge' });
  } catch (error) {
    test.skip(true, `这台机器上没有可用的 Edge，冒烟没有运行：${(error as Error).message.split('\n')[0]}`);
    return;
  }
  stage = await startStage();
  page = await browser.newPage({ baseURL: stage.url, viewport: DESK });
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('pageerror', (error) => problems.push(String(error)));
});

test.afterAll(async () => {
  await browser?.close();
  if (!service || service.exitCode !== null) return;
  // Closing its stdin is how the service is told to stop and remove its data directory.
  service.stdin!.end();
  await Promise.race([once(service, 'exit'), new Promise((resolve) => setTimeout(resolve, 15_000))]);
  if (service.exitCode === null) service.kill();
});

test('signing in with a one-time link opens the overview', async () => {
  // Without a login the console is not served at all.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '进入 Tycho' })).toBeVisible();

  await page.goto(stage.login);
  await page.getByRole('button', { name: '进入' }).click();
  await expect(page).toHaveURL(`${stage.url}/`);
  await expect(page.getByRole('heading', { level: 1, name: '总览' })).toBeVisible();
  // Every project has its own conversation, and the side column leads to each.
  await expect(projectsNav().getByRole('link', { name: /试跑/ })).toBeVisible();
  // The side column has read the work: it counts what waits for the owner.
  await expect(overviewLink().getByLabel(/^\d+ 件等你$/)).toBeVisible();
});

test("a message sent to a project's Router shows at once and gets its reply", async () => {
  await projectsNav().getByRole('link', { name: /试跑/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/projects/${stage.project}$`));
  const box = page.getByRole('textbox', { name: '给总控发消息' });
  await box.fill('冒烟：你好');
  await box.press('Enter');
  const log = page.getByRole('log', { name: '对话' });
  await expect(log.getByText('冒烟：你好', { exact: true })).toBeVisible();
  await expect(log.getByText('回复：冒烟：你好')).toBeVisible();
  await expect(box).toHaveValue('');
  await log.getByRole('button', { name: '查看经过' }).last().click();
  const trajectory = page.getByRole('dialog', { name: '这条消息的处理经过' });
  await expect(trajectory.getByText('发给总控的本轮输入')).toBeVisible();
  await trajectory.getByText('发给总控的本轮输入').click();
  await expect(trajectory.locator('pre').first()).toContainText('冒烟：你好');
  await page.keyboard.press('Escape');
  await expect(trajectory).toHaveCount(0);
  // The question a task is waiting on stands in the conversation too.
  await expect(log.getByText('冒烟用哪个浏览器？')).toBeVisible();
  // Beside the conversation, the project's work that is not over.
  await expect(page.getByRole('complementary', { name: '这个项目的工作' }).getByRole('link', { name: /发布新控制台/ })).toBeVisible();
  // The button sends too.
  await box.fill('冒烟：再来');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(log.getByText('回复：冒烟：再来')).toBeVisible();
});

test('the overview says what needs the owner and what is moving', async () => {
  await overviewLink().click();
  await expect(page).toHaveURL(/#\/$/);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: '总览' })).toBeVisible();
  await expect(main.getByRole('heading', { level: 2 }).first()).toContainText('1 件等你决定');
  await expect(main.getByRole('list', { name: '工作概况' })).toContainText('等你决定');
  await expect(main.getByRole('region', { name: '需要你处理' }).getByText('冒烟用哪个浏览器？')).toBeVisible();
  await expect(main.getByRole('region', { name: '正在进行' }).getByRole('link', { name: /修登录页的提示/ })).toBeVisible();
  await expect(main.getByRole('region', { name: '刚结束' })).toBeVisible();
  // A new installation: what is still to be set up is said on the page.
  await expect(main.getByRole('region', { name: /不处理就用不了|建议配置的事/ }).first()).toBeVisible();
});

test('the side column leads to every view', async () => {
  await page.setViewportSize(DESK);
  const places: [Locator, string, RegExp][] = [
    [views(), '工作', /#\/work$/], [projectsNav(), '项目', /#\/projects$/],
    [setup(), '知识', /#\/knowledge$/], [setup(), '职能', /#\/roles$/], [setup(), '账号', /#\/accounts$/], [setup(), '机器', /#\/machines$/], [setup(), '设置', /#\/settings$/],
  ];
  for (const [nav, name, address] of places) {
    await nav.getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(address);
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  }
  await projectsNav().getByRole('link', { name: /试跑/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/projects/${stage.project}$`));
  await overviewLink().click();
  await expect(page).toHaveURL(/#\/$/);
  // What the service is doing is always in sight, and folded while all is well.
  await expect(page.getByText('一切正常')).toBeVisible();
});

test('a tier’s dispatch order is moved on the accounts page, and it holds', async () => {
  await page.goto('#/accounts');
  const decide = page.getByRole('list', { name: '执行档派发顺序' });
  // Each row's second span is its name; the list is read only once the page has drawn it.
  const names = () => decide.getByRole('listitem').locator('span:nth-of-type(2)').allTextContents();
  await expect.poll(async () => (await names()).length).toBeGreaterThan(1);
  const before = await names();
  await decide.getByRole('listitem').filter({ hasText: before[0]! }).getByRole('button', { name: /往后挪$/ }).click();
  const after = [before[1]!, before[0]!, ...before.slice(2)];
  await expect.poll(names).toEqual(after);
  await page.reload();
  await expect.poll(names).toEqual(after);
});

// project-sessions §1: every login and back, through the service; the chosen list waits.
test('a project goes to every login and back to the chosen ones, and the list holds across a reload', async () => {
  await page.goto(`/#/projects/${stage.project}/settings`);
  const card = settingsOf('试跑');
  await card.getByRole('radio', { name: '全部登录' }).check();
  await save(card).click();
  await expect(save(card)).toHaveCount(0);
  await page.reload();
  await expect(card).toContainText('全部登录：派发时按每个档位的全局顺序挑');
  await expect(logins(card)).toHaveCount(0);
  await card.getByRole('radio', { name: '只用所选' }).check();
  await save(card).click();
  await expect(save(card)).toHaveCount(0);
  await page.reload();
  await expect(logins(card).getByRole('checkbox', { name: '机器 h2 上的 claude 登录' })).toBeChecked();
});

test('a project controller and its tier can be saved and reset independently', async () => {
  await page.goto(`/#/projects/${stage.project}/settings`);
  const card = settingsOf('试跑');
  const controller = card.getByRole('combobox', { name: '项目总控账号' });
  await expect(controller).toHaveValue('');
  const local = controller.locator('option').filter({ hasText: 'h1' });
  await expect(local).toHaveCount(1);
  await controller.selectOption(await local.getAttribute('value') ?? '');
  const tier = card.getByRole('combobox', { name: '项目总控档位' });
  await tier.selectOption('execute');
  await save(card).click();
  await expect(save(card)).toHaveCount(0);
  await page.reload();
  await expect(controller).not.toHaveValue('');
  await expect(tier).toHaveValue('execute');
  await controller.selectOption('');
  await save(card).click();
  await expect(save(card)).toHaveCount(0);
  await page.reload();
  await expect(controller).toHaveValue('');
  await expect(tier).toHaveCount(0);
});

test('project history finds a reported result and opens the exact round', async () => {
  await page.goto(`/#/projects/${stage.project}/work`);
  const search = page.getByRole('search', { name: '搜索历史证据' });
  await search.getByRole('searchbox', { name: '关键词' }).fill('圆角');
  await search.getByRole('button', { name: '搜索' }).click();
  const history = page.getByRole('region', { name: '历史证据' });
  await expect(history.getByText(/颜色、字号、圆角/)).toBeVisible();
  await expect(history.getByLabel('提交证据')).toContainText('abc1234');
  const round = history.getByRole('link', { name: /查看轮次/ });
  await round.click();
  await expect(page).toHaveURL(new RegExp(`#/task/${stage.reported}[?]run=`));
  await expect(page.getByRole('heading', { name: '汇报' })).toBeVisible();
});

// docs/design/triggers.md §7: the trigger form and the service agree on the definition's shape.
test("a trigger made on a project's page is kept by the service and listed with its next moment", async () => {
  await page.goto(`/#/projects/${stage.project}/triggers`);
  const section = page.getByRole('region', { name: '试跑 的触发器' });
  await section.getByRole('button', { name: '新建触发器' }).click();
  const form = page.getByRole('dialog', { name: '新建触发器' });
  await form.getByRole('textbox', { name: '触发器的名字' }).fill('早检');
  await form.getByRole('textbox', { name: '固定指令' }).fill('检查构建');
  await form.getByRole('button', { name: '保存触发器' }).click();
  await expect(form).toHaveCount(0);
  await page.reload();
  const row = page.getByRole('region', { name: '试跑 的触发器' }).getByRole('listitem', { name: '触发器 早检' });
  await expect(row).toContainText('cron 0 8 * * *');
  await expect(row).toContainText(/下一次：\d{4}-\d{2}-\d{2} 08:00/);
});

test('the roles page lists the four roles every service starts with', async () => {
  await page.goto('/#/roles');
  for (const name of ['实现', '审阅', '分析', '验证']) await expect(page.getByRole('region', { name: `职能 ${name}` })).toBeVisible();
  await expect(page.getByRole('region', { name: /^职能 / })).toHaveCount(4);
});

test('a work leads to its task, and the task page shows the brief, what the Worker did and its report', async () => {
  await views().getByRole('link', { name: '工作', exact: true }).click();
  await expect(page).toHaveURL(/#\/work$/);
  await page.getByRole('main').getByRole('link', { name: /发布新控制台/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/work/${stage.work}$`));
  // A row reads left to right: its state's sign, the task, and at its end when it last ran.
  const row = page.getByRole('main').getByRole('link', { name: /整理设计变量/ });
  const [sign, name, when] = [await row.locator('svg').first().boundingBox(), await row.getByText('整理设计变量').boundingBox(), await row.locator(':scope > span').last().boundingBox()];
  expect(sign!.x).toBeLessThan(name!.x);
  expect(name!.x).toBeLessThan(when!.x - 200);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`#/task/${stage.reported}$`));
  await expect(page.getByRole('heading', { level: 1, name: '整理设计变量' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /派发说明 · 第 1 轮/ })).toBeVisible();
  // The round has ended: its report is what to read, and what it did is folded under one line.
  await expect(page.getByRole('heading', { name: '汇报' })).toBeVisible();
  const fold = page.getByText('过程记录 · 2 次工具调用，1 次失败');
  await expect(fold).toBeVisible();
  await expect(page.getByText('先看现有的样式。')).toBeHidden();
  await fold.click();
  await expect(page.getByText('先看现有的样式。')).toBeVisible();
  await expect(page.getByText('Read', { exact: true })).toBeVisible();
  await expect(page.getByText('一套变量')).toBeVisible();
  // An implementation needs an independent review before it can be accepted: the real
  // service says so, and offers the owner the one way past it.
  await expect(page.getByText(/这个任务要独立审阅/)).toBeVisible();
  await expect(page.getByRole('button', { name: '不经审阅验收' })).toBeVisible();
  await expect(page.getByRole('button', { name: '验收通过' })).toHaveCount(0);
  // The task's facts stand beside the site, and the drawer that says why this round
  // started is opened from them: opened, read, closed.
  const details = page.getByRole('complementary', { name: '任务详情' });
  await expect(details.getByRole('link', { name: '发布新控制台' })).toBeVisible();
  const trace = details.getByRole('button', { name: '为什么开始这一轮' });
  await trace.click();
  const drawer = page.getByRole('dialog', { name: '第 1 轮为什么开始' });
  await expect(drawer.getByRole('heading', { name: '触发' })).toBeVisible();
  await expect(drawer.getByText('账本已提交操作。')).toBeVisible();
  await expect(drawer.getByText('总控是否收到结果未知。')).toBeVisible();
  await drawer.getByText('查看工具输入与结果').click();
  await expect(drawer.locator('pre').getByText(/"title":"整理设计变量"/)).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '结算与通知' })).toBeVisible();
  await drawer.getByRole('button', { name: '关闭' }).click();
  await expect(drawer).toBeHidden();
  // The keyboard is back where it was.
  await expect(trace).toBeFocused();
});

test('a setting is changed where it stands and the new value holds after a reload', async () => {
  await setup().getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('link', { name: '执行', exact: true }).click();
  const row = page.locator('[id="setting-run.lostGraceMs"]');
  const field = page.getByRole('textbox', { name: '机器失联宽限期' });
  await expect(field).toHaveValue('10');
  // Nothing typed over it: there is nothing to send.
  await expect(row.getByRole('button', { name: '保存' })).toHaveCount(0);
  await field.fill('25');
  await expect(row.getByRole('button', { name: '保存' })).toBeVisible();
  await field.press('Enter');
  await expect(row).toContainText('现在：25 分钟 · 默认：10 分钟');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '机器失联宽限期' })).toHaveValue('25');
  await expect(page.locator('[id="setting-run.lostGraceMs"]')).toContainText('由网页修改');
});

test('the settings groups stay in sight while a group is scrolled, and the search leads into another group', async () => {
  for (const size of [DESK, PHONE]) {
    await page.setViewportSize(size);
    // The longest group, so that its page has somewhere to scroll to.
    await page.goto('/#/settings/机器');
    const groups = page.getByRole('navigation', { name: '设置分组' });
    const current = groups.getByRole('link', { name: '机器', exact: true });
    await expect(current).toHaveAttribute('aria-current', 'page');
    // Down to the end of the group's page, in whichever box scrolls at this width.
    const far = await page.getByRole('main').evaluate((main) => Math.max(0, ...[...main.querySelectorAll<HTMLElement>('[data-scroll]')].map((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    })));
    expect(far, `${size.width} 宽时这一组没有可滚的内容，测不到目录是否跟随`).toBeGreaterThan(0);
    // There: the groups, the one in view among them, and the search box are all still on
    // the screen.
    // The last setting of the group: machine.sweepMs, after the machine timings were registered.
    await expect(page.locator('[id="setting-machine.sweepMs"]')).toBeInViewport();
    await expect(groups).toBeInViewport({ ratio: 1 });
    await expect(current).toBeInViewport();
    await expect(page.getByRole('combobox', { name: '搜索设置' })).toBeInViewport({ ratio: 1 });
    // The title is the page's bar: it stands still at both widths, and on a phone the
    // button that opens the side column stands in it.
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: '设置' })).toBeInViewport({ ratio: 1 });
    if (size === PHONE) await expect(page.getByRole('button', { name: '菜单' })).toBeInViewport({ ratio: 1 });
    // The page itself never scrolls sideways; on a phone the groups slide within their own row.
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways, `${size.width} 宽时页面有横向滚动`).toBeLessThanOrEqual(1);
  }
  // On the phone, a link to an item far along the row finds its group slid into sight, and
  // the last group opens its own page.
  await page.goto('/#/settings/backup.dir');
  const far = page.getByRole('navigation', { name: '设置分组' }).getByRole('link', { name: '备份', exact: true });
  await expect(far).toHaveAttribute('aria-current', 'page');
  await expect(far).toBeInViewport({ ratio: 1 });
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('link', { name: '部署信息' }).click();
  await expect(page.getByRole('heading', { name: '部署信息' })).toBeVisible();

  await page.setViewportSize(DESK);
  const search = page.getByRole('combobox', { name: '搜索设置' });
  await search.fill('失联');
  const results = page.getByRole('listbox', { name: '搜索结果' });
  await expect(results.getByRole('group', { name: '执行' })).toBeVisible();
  await results.getByRole('option', { name: /机器失联宽限期/ }).click();
  await expect(page).toHaveURL(/#\/settings\/run\.lostGraceMs$/);
  await expect(page.getByRole('navigation', { name: '设置分组' }).getByRole('link', { name: '执行', exact: true })).toHaveAttribute('aria-current', 'page');
  const row = page.locator('[id="setting-run.lostGraceMs"]');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(row).toBeInViewport();
  await expect(results).toHaveCount(0);
});

test('the machines page says how a machine joins, keeps a note on one, and sets up the claude already signed in there', async () => {
  await setup().getByRole('link', { name: '机器', exact: true }).click();
  await expect(page).toHaveURL(/#\/machines$/);
  await page.getByRole('button', { name: '接入一台机器' }).click();
  const joining = page.getByRole('dialog', { name: '接入一台机器' });
  await expect(joining).toContainText('tycho node join --to');
  await expect(joining.getByRole('region', { name: '等着放行的机器' })).toBeVisible();
  await joining.getByRole('button', { name: '关闭' }).click();
  await expect(joining).toHaveCount(0);
  // The note is one of the less common things to do to a machine: it is in its menu.
  const h2 = page.getByRole('region', { name: '机器 h2' });
  await h2.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '加备注' }).click();
  const noting = page.getByRole('dialog', { name: '机器 h2 的备注' });
  await noting.getByRole('textbox', { name: '备注' }).fill('GPU 机器');
  await noting.getByRole('button', { name: '保存' }).click();
  await expect(noting).toHaveCount(0);
  await expect(h2).toContainText('GPU 机器');
  // The claude already signed in on h1 is that machine's own login: its two tiers and limits
  // are set from its block among that machine's executors, in a drawer beside the page.
  const own = page.getByRole('region', { name: '机器 h1' }).getByRole('group', { name: 'h1 上的 claude 登录' });
  await own.getByRole('button', { name: '修改' }).click();
  const editor = page.getByRole('dialog', { name: 'h1 上的 claude 登录' });
  await editor.getByText('更多设置').click();
  await editor.getByRole('textbox', { name: '同时最多几轮执行' }).fill('2');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toHaveCount(0);
  await expect(own.getByRole('alert')).toHaveCount(0);
  // Kept by the service, not only by the page: read again from scratch, it is still there.
  await page.reload();
  await page.getByRole('region', { name: '机器 h1' }).getByRole('group', { name: 'h1 上的 claude 登录' }).getByRole('button', { name: '修改' }).click();
  const again = page.getByRole('dialog', { name: 'h1 上的 claude 登录' });
  await again.getByText('更多设置').click();
  await expect(again.getByRole('textbox', { name: '同时最多几轮执行' })).toHaveValue('2');
  await again.getByRole('button', { name: '取消' }).click();
  await expect(again).toHaveCount(0);
});

// The accounts on the page, by the name over each card. A new account is named by the service,
// so the one just added is the one that was not there before. Read also while a window is
// open over the page, which hides the cards from a screen reader and leaves them there.
const accountNames = (): Promise<string[]> =>
  page.getByRole('main', { includeHidden: true }).getByRole('region', { includeHidden: true }).evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label') ?? ''));
async function addedSince(before: string[]): Promise<string> {
  await expect.poll(async () => (await accountNames()).filter((name) => !before.includes(name)).length).toBe(1);
  return (await accountNames()).find((name) => !before.includes(name))!;
}

test('an account is added on the accounts page with the API key that is the account, and no name asked for', async () => {
  await setup().getByRole('link', { name: '账号', exact: true }).click();
  await expect(page).toHaveURL(/#\/accounts$/);
  await page.getByRole('button', { name: '添加账号' }).click();
  const account = page.getByRole('dialog', { name: '添加账号' });
  // One window asks which executor and how its login is obtained: every executor here has a
  // way, each as its adapter declares it.
  await expect(account.getByRole('radio', { name: /^claude/ })).toBeChecked();
  await expect(account.getByRole('radio', { name: /^codex/ })).toBeEnabled();
  await expect(account.getByRole('radio', { name: /^dsh/ })).toBeEnabled();
  // A Claude login is signed in to on Claude's own page and nowhere typed: that is its one way.
  await expect(account.getByRole('group', { name: '怎么登录' }).getByRole('radio')).toHaveCount(1);
  await expect(account.getByRole('radio', { name: /^在官方页面授权/ })).toBeVisible();
  // No name is asked for, here or with the key: the service gives one.
  await expect(account.getByRole('textbox', { name: '名字' })).toHaveCount(0);
  const before = await accountNames();
  await account.getByRole('radio', { name: /^codex/ }).check();
  await account.getByRole('radio', { name: /^填 API 密钥/ }).check();
  await account.getByRole('button', { name: '下一步' }).click();
  // An account is the login tycho keeps: it is made with one.
  await expect(account.getByRole('textbox', { name: '名字' })).toHaveCount(0);
  await account.getByLabel('API 密钥', { exact: true }).fill('smoke-first-credential');
  // A new account offers all three tiers; leaving the operation tier blank uses the execution tier.
  const tiers = account.getByRole('group', { name: /^第 \d+ 个档位$/ });
  await expect(tiers).toHaveCount(3);
  await tiers.filter({ has: page.getByText('执行档', { exact: true }) }).getByLabel('模型').fill('<模型名>');
  await tiers.filter({ has: page.getByText('决策档', { exact: true }) }).getByLabel('模型').fill('<模型名>');
  await account.getByRole('button', { name: '保存' }).click();
  await expect(account).toHaveCount(0);
  const given = await addedSince(before);
  expect(given).not.toBe('');
  const added = page.getByRole('region', { name: given, exact: true });
  await expect(added).toContainText('已设置');
  await expect(page.getByRole('button', { name: '添加账号' })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('smoke-first-credential');
  // The name is the owner's to change afterwards, on the account itself.
  await added.getByRole('button', { name: '修改' }).click();
  const editor = page.getByRole('dialog', { name: `修改 ${given}` });
  await editor.getByRole('textbox', { name: '名字', exact: true }).fill('smoke');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'smoke', exact: true })).toBeVisible();
});

test('a dsh account is a line and its key: picked, filled and saved in the same window', async () => {
  await page.goto('/#/accounts');
  await page.getByRole('button', { name: '添加账号' }).click();
  const account = page.getByRole('dialog', { name: '添加账号' });
  await account.getByRole('radio', { name: /^dsh/ }).check();
  const before = await accountNames();
  await account.getByRole('button', { name: '下一步' }).click();
  await account.getByRole('textbox', { name: '地址' }).fill('http://10.0.0.8:53000/v1');
  await account.getByLabel('第 1 个模型的名字').fill('smoke-model');
  await account.getByRole('group', { name: '第 1 个模型' }).getByRole('checkbox', { name: 'high', exact: true }).check();
  await account.getByLabel('API 密钥', { exact: true }).fill('smoke-line-key-0001');
  // The tiers pick from the models this line serves, and do not ask which line.
  const tiers = account.getByRole('group', { name: /^第 \d+ 个档位$/ });
  await tiers.filter({ has: page.getByText('执行档', { exact: true }) }).getByRole('combobox').first().selectOption('smoke-model');
  await account.getByRole('button', { name: '保存' }).click();
  await expect(account).toHaveCount(0);
  // Named by the service: the card that was not there before.
  await expect(page.getByRole('region', { name: await addedSince(before), exact: true })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('smoke-line-key-0001');
});

test('an account can be renamed in its drawer without changing its identity', async () => {
  await page.goto('/#/accounts');
  const rename = async (from: string, to: string): Promise<string> => {
    await page.getByRole('region', { name: from, exact: true }).getByRole('button', { name: '修改' }).click();
    const editor = page.getByRole('dialog', { name: `修改 ${from}` });
    await editor.getByRole('textbox', { name: '名字', exact: true }).fill(to);
    const request = page.waitForRequest((sent) => sent.method() === 'PUT' && /\/api\/accounts\/[^/]+$/.test(new URL(sent.url()).pathname));
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const sent = await request;
    await expect(editor).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('region', { name: to, exact: true })).toBeVisible();
    return new URL(sent.url()).pathname;
  };
  const renamed = await rename('smoke', 'smoke-renamed');
  expect(renamed).toMatch(/\/api\/accounts\/[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(await rename('smoke-renamed', 'smoke')).toBe(renamed);
});



// The stand-in CLI behind the helper (tests/fake-claude-login.mjs): the helper is Windows-only.
test('a Claude account is signed in on Claude\'s own page from the one "添加账号" window, then given its tiers', async () => {
  test.skip(process.platform !== 'win32', '登录助手只在 Windows 主机上有');
  await page.goto('/#/accounts');
  await expect(page.getByRole('button', { name: /登录 Claude/ })).toHaveCount(0);
  await page.getByRole('button', { name: '添加账号' }).click();
  const window = page.getByRole('dialog', { name: '添加账号' });
  // Signing in on the executor's own page is the way a host that can do it offers first.
  await expect(window.getByRole('radio', { name: /^在官方页面授权/ })).toBeChecked();
  const before = await accountNames();
  await window.getByRole('button', { name: '开始登录' }).click();
  const go = window.getByRole('link', { name: '前往 Claude 授权' });
  await expect(go).toBeVisible({ timeout: 30_000 });
  await expect(go).toHaveAttribute('href', /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  await window.getByRole('textbox', { name: '授权码' }).fill('smoke-code#smoke-state');
  await window.getByRole('button', { name: '提交授权码' }).click();
  // The tiers are asked for once the login is in and its models were read, or given up on.
  const tiers = window.getByRole('group', { name: /^第 \d+ 个档位$/ });
  await tiers.filter({ has: page.getByText('执行档', { exact: true }) }).getByLabel('模型').selectOption('<模型名>', { timeout: 60_000 });
  await window.getByRole('button', { name: '保存' }).click();
  await expect(window).toHaveCount(0);
  // Named by the service, after who the login said it was where it said.
  const given = await addedSince(before);
  const added = page.getByRole('region', { name: given, exact: true });
  // A login made on Claude's own page is said as a login, with no box to type one into.
  await expect(added).toContainText('已登录');
  // At a phone's width the window fits the screen.
  await page.setViewportSize(PHONE);
  await added.getByRole('button', { name: '重新登录' }).click();
  const again = page.getByRole('dialog', { name: `重新登录 ${given}` });
  await expect(again.getByRole('link', { name: '前往 Claude 授权' })).toBeVisible({ timeout: 30_000 });
  const box = await again.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  // Closing is cancelling: the account keeps the login it had.
  await page.keyboard.press('Escape');
  await expect(again).toHaveCount(0);
  await expect(added).toContainText('已登录');
  await page.setViewportSize(DESK);
});

test('a machine asking to join is let in through the one entry in the sidebar and is listed on the machines page', async () => {
  const asked = await fetch(stage.url + '/api/node/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: NODE_PROTOCOL, facts: { node_id: 'e2e0e2e0e2e0e2e0', name: 'smoke-node', platform: 'linux 6', hostname: 'smoke-node.local' } }),
  });
  expect(asked.status).toBe(201);
  const { code } = await asked.json() as { code: string };
  await setup().getByRole('link', { name: '机器', exact: true }).click();
  // The machines asking to be let in are listed in the window that says how one joins.
  await page.getByRole('button', { name: '接入一台机器' }).click();
  const joining = page.getByRole('dialog', { name: '接入一台机器' });
  await expect(joining.getByRole('region', { name: '等着放行的机器' }).getByText('smoke-node', { exact: true })).toBeVisible();
  await joining.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '放行', exact: true }).click();
  const admitting = page.getByRole('dialog', { name: '放行' });
  await admitting.getByRole('textbox', { name: '六位数字' }).fill(code);
  await admitting.getByRole('button', { name: '查找' }).click();
  const request = admitting.getByRole('region', { name: '等待放行的机器' });
  await expect(request).toContainText('linux 6 · smoke-node.local');
  await request.getByRole('button', { name: '放行', exact: true }).click();
  await expect(admitting.getByRole('status')).toContainText('已放行 smoke-node');
  await admitting.getByRole('button', { name: '关闭' }).click();
  await expect(page.getByRole('region', { name: '机器 smoke-node' })).toBeVisible();
  // Let in, it is no longer waiting.
  await page.getByRole('button', { name: '接入一台机器' }).click();
  await expect(joining.getByRole('region', { name: '等着放行的机器' })).toContainText('现在没有等着放行的机器');
  await expect(joining.getByText('smoke-node', { exact: true })).toHaveCount(0);
  await joining.getByRole('button', { name: '关闭' }).click();
  await expect(joining).toHaveCount(0);
});

test('deleted machine restrictions survive another save and clearing them requires confirmation', async () => {
  const headers = { Origin: stage.url };
  const machines = await (await page.request.get('/api/machines')).json();
  const uid = machines.machines.find((machine: { id: string }) => machine.id === 'smoke-node').uid;
  const created = await page.request.post('/api/projects', { headers, data: { name: '机器限制回归', machines: [uid] } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).project.id;
  expect((await page.request.delete('/api/machines/smoke-node', { headers })).status()).toBe(200);
  const read = async () => (await (await page.request.get('/api/projects')).json()).projects.find((project: { id: string }) => project.id === id);

  await page.goto(`/#/projects/${id}/settings`);
  const card = settingsOf('机器限制回归');
  await expect(card).toContainText('现在哪台机器都不会接它的活');
  // Nothing changed yet: there is nothing to send.
  await expect(save(card)).toHaveCount(0);
  await card.getByRole('switch', { name: '允许派生机器' }).click();
  await save(card).click();
  await expect(save(card)).toHaveCount(0);
  expect(await read()).toMatchObject({ machines: [], machines_gone: 1, spawn_machines: true });
  await page.reload();
  await expect(card).toContainText('现在哪台机器都不会接它的活');

  await page.setViewportSize(PHONE);
  await card.getByRole('button', { name: '去掉已删除的机器条目' }).click();
  await save(card).click();
  const confirmation = page.getByRole('alertdialog', { name: '允许哪台机器都接活？' });
  await expect(confirmation).toContainText('保存后不再限制机器，哪台机器都行');
  const bounds = await confirmation.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(PHONE.width);
  await confirmation.getByRole('button', { name: '取消' }).click();
  await expect(confirmation).toHaveCount(0);
  expect(await read()).toMatchObject({ machines: [], machines_gone: 1 });
  await save(card).click();
  await confirmation.getByRole('button', { name: '确认不限制机器并保存' }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(save(card)).toHaveCount(0);
  expect(await read()).toMatchObject({ machines: [], machines_gone: 0 });
  await page.setViewportSize(DESK);
});

test('a typed API key is write-only and is replaced, never taken off', async () => {
  await page.goto('/#/accounts');
  const account = page.getByRole('region', { name: 'smoke', exact: true });
  await expect(account).toContainText('已设置');
  // The key has a window of its own, opened from the account's menu.
  const window = page.getByRole('dialog', { name: '更换 smoke 的 API 密钥' });
  const token = window.getByLabel('API 密钥', { exact: true });
  const open = async () => {
    await account.getByRole('button', { name: '更多' }).click();
    // Replacing is the one thing the menu offers for the key: there is no taking it off.
    await expect(page.getByRole('menuitem', { name: /清除/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: '更换 API 密钥' }).click();
  };
  await open();
  await expect(token).toHaveAttribute('type', 'password');
  await expect(token).toHaveValue('');
  await expect(window).toContainText('现在：已设置');
  await expect(window.getByRole('button', { name: '清除', exact: true })).toHaveCount(0);
  await token.fill('smoke-private-credential');
  await window.getByRole('button', { name: '保存密钥', exact: true }).click();
  await expect(window).toHaveCount(0);
  await expect(account).toContainText('已设置');
  await open();
  await expect(token).toHaveValue('');
  await page.reload();
  await open();
  await expect(token).toHaveValue('');
  await expect(window).toContainText('现在：已设置');
  await window.getByRole('button', { name: '取消' }).click();
  await expect(window).toHaveCount(0);
  await expect(account).toContainText('已设置');
  await expect(account.getByRole('button', { name: '清除', exact: true })).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText('smoke-private-credential');
});

test('at phone width a signed-in device temporarily approves, lists and signs out a new browser', async () => {
  const newcomer = await browser!.newContext({ baseURL: stage.url, viewport: PHONE });
  try {
    const waiting = await newcomer.newPage();
    await waiting.goto('/login');
    await waiting.getByRole('button', { name: '在这台设备上登录' }).click();
    const code = await waiting.getByRole('heading', { level: 1 }).textContent();
    expect(code).toMatch(/^[0-9]{6}$/);
    await expect(waiting).toHaveURL(/\/login\/device$/);

    await page.setViewportSize(PHONE);
    await page.goto('/#/');
    await page.getByRole('button', { name: '菜单' }).click();
    // The one entry for letting something in by its six digits.
    const admit = page.getByRole('button', { name: '放行', exact: true });
    await admit.click();
    const admitting = page.getByRole('dialog', { name: '放行' });
    await admitting.getByRole('textbox', { name: '六位数字' }).fill(code!);
    await admitting.getByRole('button', { name: '查找' }).click();
    const drawer = admitting;
    const request = drawer.getByRole('region', { name: '等待放行的设备' });
    await expect(request.getByText(/^在主机这台电脑上 · /)).toBeVisible();
    await expect(drawer.getByText(code!, { exact: true })).toBeVisible();
    await expect(drawer.getByText('只有你自己面前那台设备上显示着同样的数字时才放行。')).toBeVisible();
    const wide = await drawer.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(wide, '放行抽屉有横向滚动').toBe(false);
    const bounds = await drawer.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(PHONE.width);
    await expect(drawer.getByRole('button', { name: '放行，保持 30 天' })).toBeVisible();
    await drawer.getByRole('button', { name: '放行，只保持 12 小时' }).click();
    await expect(drawer.getByRole('status')).toContainText('已放行：');
    await expect(waiting).toHaveURL(stage.url + '/', { timeout: 15_000 });
    await expect(waiting.getByRole('heading', { level: 1, name: '总览' })).toBeVisible();
    await admitting.getByRole('button', { name: '关闭' }).click();
    await expect(admit).toBeFocused();
    // The devices signed in are their own drawer.
    const trigger = page.getByRole('button', { name: '设备' });
    await trigger.click();
    const devicesDrawer = page.getByRole('dialog', { name: '设备' });
    await devicesDrawer.getByRole('button', { name: '刷新设备' }).click();
    const devices = devicesDrawer.getByRole('region', { name: '已登录的设备' });
    await expect(devices.getByText('这一台', { exact: true })).toBeVisible();
    await expect(devices.getByRole('button', { name: '让它退出' })).toHaveCount(1);
    await expect(devices.getByText(/到期：/)).toHaveCount(2);
    const listWide = await devicesDrawer.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(listWide, '设备清单有横向滚动').toBe(false);
    const sheet = await devicesDrawer.boundingBox();
    expect(sheet!.x).toBeGreaterThanOrEqual(0);
    expect(sheet!.x + sheet!.width).toBeLessThanOrEqual(PHONE.width);
    await devices.getByRole('button', { name: '让它退出' }).click();
    let confirmation = page.getByRole('alertdialog', { name: '让这台设备退出？' });
    await expect(confirmation).toBeVisible();
    const confirmBounds = await confirmation.boundingBox();
    expect(confirmBounds!.x).toBeGreaterThanOrEqual(0);
    expect(confirmBounds!.x + confirmBounds!.width).toBeLessThanOrEqual(PHONE.width);
    await confirmation.getByRole('button', { name: '取消' }).click();
    await expect(devices.getByRole('button', { name: '让它退出' })).toHaveCount(1);
    await devices.getByRole('button', { name: '让它退出' }).click();
    confirmation = page.getByRole('alertdialog', { name: '让这台设备退出？' });
    await confirmation.getByRole('button', { name: '确认退出' }).click();
    await expect(devices.getByRole('button', { name: '让它退出' })).toHaveCount(0);
    await expect(devices.getByText('这一台', { exact: true })).toBeVisible();
    await waiting.reload();
    await expect(waiting).toHaveURL(/\/login$/);
    await devicesDrawer.getByRole('button', { name: '关闭' }).click();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(views()).toBeHidden();
  } finally {
    await newcomer.close();
  }
});

test('at a phone width every page fits: the side column is a menu and nothing scrolls sideways', async () => {
  await page.setViewportSize(PHONE);
  for (const [, hash, shown] of pagesOf(stage)) {
    await page.goto(`/${hash}`);
    await expect(page.getByRole('button', { name: '菜单' })).toBeVisible();
    await expect(shown(page)).toBeVisible();
    await expect(page.getByText('正在读取…')).toHaveCount(0);
    // The page itself and every part of it that scrolls.
    const wide = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('[data-scroll], main, #side')]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''} ${node.scrollWidth}>${node.clientWidth}`));
    expect(wide, `${hash} 有横向滚动`).toEqual([]);
  }
  // A round at work, at a phone's width: a command too long for the row is cut at its end
  // and its state stays whole on one line beside it; the table scrolls in its own box.
  await page.goto(`/#/task/${stage.running}`);
  const failed = page.locator('[data-tool][data-status="failed"]');
  await expect(failed).toBeVisible();
  const title = failed.locator('summary span.truncate');
  const state = failed.getByText('失败', { exact: true });
  const [titleBox, stateBox] = [await title.boundingBox(), await state.boundingBox()];
  expect(stateBox!.height, '“失败”被挤成了竖排').toBeLessThan(titleBox!.height * 1.5);
  expect(Math.abs(stateBox!.y - titleBox!.y), '状态没和标题在一行').toBeLessThan(titleBox!.height);
  expect(await title.evaluate((node) => node.scrollWidth > node.clientWidth), '长命令没有在行尾截断').toBe(true);
  expect(await title.evaluate((node) => getComputedStyle(node).color)).not.toBe(await state.evaluate((node) => getComputedStyle(node).color));
  const table = page.getByRole('region', { name: '表格' });
  await expect(table.locator('table')).toBeVisible();
  expect(await table.evaluate((node) => node.scrollWidth > node.clientWidth), '表格在自己的框里横向滚').toBe(true);
  // On a phone the task's facts fold under one line, and open on request.
  const details = page.getByRole('complementary', { name: '任务详情' });
  await expect(details.getByRole('heading', { name: '执行记录' })).toBeHidden();
  await details.getByText('任务详情', { exact: true }).click();
  await expect(details.getByRole('heading', { name: '执行记录' })).toBeVisible();

  // What has nowhere to break is on these pages, whole, and takes as many lines as it needs.
  await page.goto(`/#/projects/${stage.project}`);
  const option = page.getByRole('button', { name: /^两个都跑：/ });
  await expect(option).toBeVisible();
  const [box, card] = [await option.boundingBox(), await page.getByRole('region', { name: /^等你决定/ }).boundingBox()];
  expect(box!.x + box!.width, '选项伸到了卡片外面').toBeLessThanOrEqual(card!.x + card!.width);
  expect(box!.height, '长选项没有换行').toBeGreaterThan(60);
  // The work beside the conversation has no room here: it is the project's 工作 tab.
  await expect(page.getByRole('complementary', { name: '这个项目的工作' })).toBeHidden();
  await page.goto('/#/');
  await expect(page.getByRole('main').getByRole('link', { name: LONG_TITLE })).toBeVisible();

  // The menu opens over the page, takes the keyboard, and Escape shuts it again.
  await expect(views()).toBeHidden();
  await page.getByRole('button', { name: '菜单' }).click();
  await expect(overviewLink()).toBeFocused();
  const side = await page.evaluate(() => { const node = document.getElementById('side')!; return [node.scrollWidth, node.clientWidth]; });
  expect(side[0], '菜单有横向滚动').toBeLessThanOrEqual(side[1]! + 1);
  await page.keyboard.press('Escape');
  await expect(views()).toBeHidden();
  await expect(page.getByRole('button', { name: '菜单' })).toBeFocused();
  // And it leads somewhere.
  await page.getByRole('button', { name: '菜单' }).click();
  await views().getByRole('link', { name: '工作', exact: true }).click();
  await expect(page).toHaveURL(/#\/work$/);
  await expect(views()).toBeHidden();
  // The page come to has its own bar, and its menu button has the keyboard.
  await expect(page.getByRole('button', { name: '菜单' })).toBeFocused();
});

// For looking at the pages, not for asserting anything: TYCHO_E2E_SHOTS=<directory>
// saves every page at both widths, in the light and the dark scheme.
test('every page is pictured when asked for', async () => {
  const dir = process.env.TYCHO_E2E_SHOTS;
  test.skip(!dir, '没有要截图（TYCHO_E2E_SHOTS 没有设置）');
  for (const [width, size] of [['desktop', DESK], ['phone', PHONE]] as const) {
    await page.setViewportSize(size);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [name, hash, shown] of pagesOf(stage)) {
        await page.goto(`/${hash}`);
        await expect(shown(page)).toBeVisible();
        await page.screenshot({ path: `${dir}/${width}-${scheme}-${name}.png` });
      }
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // Up close, at three times the size, where a small picture misleads (a stroke of a
  // character read as a line beside it): the phone's top bar with its menu button, and
  // the side column with the pointer on an entry that is not the page in view.
  const near = await browser!.newPage({ baseURL: stage.url, storageState: await page.context().storageState(), deviceScaleFactor: 3 });
  for (const scheme of ['light', 'dark'] as const) {
    await near.emulateMedia({ colorScheme: scheme });
    await near.setViewportSize(PHONE);
    await near.goto('/#/');
    await expect(near.getByRole('button', { name: '菜单' })).toBeVisible();
    await near.screenshot({ path: `${dir}/close-${scheme}-topbar.png`, clip: { x: 0, y: 0, width: 220, height: 60 } });
    await near.setViewportSize(DESK);
    await near.getByRole('navigation', { name: '视图' }).getByRole('link', { name: '工作', exact: true }).hover();
    await near.screenshot({ path: `${dir}/close-${scheme}-side-hover.png`, clip: { x: 0, y: 0, width: 260, height: 420 } });
    await near.mouse.move(640, 400);
  }
  await near.close();
});

// The drawer itself and prose must fit; wide tables/code scroll within their own boxes.
// Measuring only document.scrollWidth misses an overflowing child clipped by the drawer.
for (const size of [DESK, PHONE]) {
  test(`final report drawer keeps prose within ${size.width}px and scrolls wide tables locally`, async ({}, testInfo) => {
    await page.setViewportSize(size);
    await page.goto(`/#/task/${stage.reported}`);
    const report = page.getByRole('heading', { name: '汇报', exact: true }).locator('..').locator('..');
    await report.getByRole('button', { name: '查看报告 最后回复' }).click();
    const drawer = page.getByRole('dialog', { name: '最后回复', exact: true });
    await expect(drawer.getByRole('heading', { name: '宽度验收报告' })).toBeVisible();
    await drawer.evaluate(async (node) => { await Promise.all(node.getAnimations().map((animation) => animation.finished)); });
    const geometry = await drawer.evaluate((node) => {
      const prose = node.querySelector<HTMLElement>('.prose')!;
      const dimensions = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, client: element.clientWidth, scroll: element.scrollWidth };
      };
      return {
        viewport: window.innerWidth,
        drawer: dimensions(node),
        prose: dimensions(prose),
        paragraphs: Array.from(prose.querySelectorAll(':scope > p')).map(dimensions),
        tables: Array.from(prose.querySelectorAll('[role="region"][aria-label="表格"]')).map(dimensions),
        code: Array.from(prose.querySelectorAll('pre')).map(dimensions),
      };
    });
    const geometryPath = testInfo.outputPath(`report-geometry-${size.width}.json`);
    await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
    await testInfo.attach(`report-geometry-${size.width}.json`, { path: geometryPath, contentType: 'application/json' });
    expect(geometry.drawer.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.drawer.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.drawer.scroll).toBeLessThanOrEqual(geometry.drawer.client + 1);
    for (const [index, block] of [geometry.prose, ...geometry.paragraphs].entries()) {
      expect(block.left, `正文块${index}左侧越过抽屉`).toBeGreaterThanOrEqual(geometry.drawer.left - 1);
      expect(block.right, `正文块${index}右侧越过抽屉`).toBeLessThanOrEqual(geometry.drawer.right + 1);
      expect(block.scroll, `正文块${index}包含被裁掉的横向内容`).toBeLessThanOrEqual(block.client + 1);
    }
    const table = drawer.getByRole('region', { name: '表格', exact: true });
    expect(await table.evaluate((node) => node.scrollWidth - node.clientWidth), '表格需要在自己的框内横向滚动').toBeGreaterThan(1);
    await table.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    expect(await table.evaluate((node) => node.scrollLeft), '表格不是被裁掉或禁止横向滚动').toBeGreaterThan(0);
    const lastCell = await table.locator('td').last().boundingBox();
    const tableBox = await table.boundingBox();
    expect(lastCell!.x + lastCell!.width).toBeLessThanOrEqual(tableBox!.x + tableBox!.width + 1);
    const code = drawer.locator('pre').first();
    expect(await code.evaluate((node) => node.scrollWidth - node.clientWidth), '长代码也只在自身滚动').toBeGreaterThan(1);
    await code.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    expect(await code.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const end = drawer.getByText('报告末段可完整阅读。', { exact: true });
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeVisible();
    const endBox = await end.boundingBox();
    expect(endBox!.x + endBox!.width).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(endBox!.y).toBeGreaterThanOrEqual(0);
    expect(endBox!.y + endBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(drawer).toHaveCount(0);
  });
}

test('logging out ends the session', async () => {
  await page.setViewportSize(DESK);
  await page.goto('/#/');
  await page.getByRole('button', { name: '设备' }).click();
  await page.getByRole('dialog', { name: '设备' }).getByRole('button', { name: '注销' }).click();
  await page.getByRole('alertdialog', { name: '注销这一台？' }).getByRole('button', { name: '确认注销' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('the browser reported no error on the way: nothing was blocked by the content policy', () => {
  expect(problems).toEqual([]);
});
