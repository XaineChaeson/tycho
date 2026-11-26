// Pictures of the "添加账号" window's new ways, for the owner to look at. Not a test: run by
// hand with the stage service, `node e2e/shots-accounts.mjs <directory>`. The machine and its
// sign-in are stood in by routes in the browser; everything else is the stage service.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const out = process.argv[2];
if (!out) throw new Error('usage: node e2e/shots-accounts.mjs <directory>');
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const child = spawn(process.execPath, ['tests/console-stage.ts'], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
let stage;
for await (const line of createInterface({ input: child.stdout })) if (line.startsWith('{')) { stage = JSON.parse(line); break; }
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage({ baseURL: stage.url, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(stage.login);
  await page.getByRole('button', { name: '进入' }).click();
  await page.getByRole('heading', { level: 1, name: '总览' }).waitFor();
  // A machine that is here with Codex on it, and a sign-in that has its address and code.
  await page.route('**/api/machines', async (route) => {
    const answer = await (await route.fetch()).json();
    answer.machines = [...answer.machines, {
      id: 'gpu-box', uid: 'uid-gpu-box', host: 'gpu-box', note: null,
      node: { node_id: 'f'.repeat(16), platform: 'linux 6.8', joined_at: '2026-11-11T00:00:00Z', last_seen_at: new Date().toISOString(), connected: true, reported_runs: 0, reported_unknown: 0, source: null, ephemeral: false, scope: null, ends: null,
        executors: { at: new Date().toISOString(), executors: [{ executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: false }] } },
      logins: [],
    }];
    await route.fulfill({ json: answer });
  });
  const view = { id: 'S1', machine: 'gpu-box', executor: 'codex', state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', reason: null, signed_in: false };
  await page.route('**/api/sign-ins**', (route) => route.fulfill({ json: { sign_in: view } }));
  await page.goto('/#/accounts');
  await page.getByRole('heading', { level: 1, name: '账号' }).waitFor();
  await page.getByRole('button', { name: '添加账号' }).click();
  const dialog = page.getByRole('dialog', { name: '添加账号' });
  await dialog.getByRole('radio', { name: /^codex/ }).check();
  await dialog.screenshot({ path: `${out}/1-codex-ways.png` });
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: '开始登录' }).click();
  await dialog.getByText('ABCD-12345').waitFor();
  await dialog.screenshot({ path: `${out}/2-codex-machine-code.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '添加账号' }).click();
  await dialog.getByRole('radio', { name: /^dsh/ }).check();
  await dialog.getByRole('textbox', { name: '名字', exact: true }).fill('内网网关');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('textbox', { name: '地址' }).fill('http://198.51.100.10:53000/v1');
  await dialog.getByLabel('第 1 个模型的名字').fill('deepseek-v4.1-flash');
  for (const effort of ['off', 'low', 'high', 'max']) await dialog.getByRole('group', { name: '第 1 个模型' }).getByRole('checkbox', { name: effort, exact: true }).check();
  await dialog.getByLabel('API 密钥', { exact: true }).fill('sk-not-a-real-key');
  await dialog.getByRole('group', { name: /^第 1 个档位$/ }).getByRole('combobox').first().selectOption('deepseek-v4.1-flash');
  await dialog.screenshot({ path: `${out}/3-dsh-line.png` });
} finally {
  await browser.close();
  child.stdin.end();
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 15_000))]);
}
