// Guards the small pieces every page is made of: a copy button that says 已复制 when the
// browser refused the write (or has no clipboard at all), and one that stays quiet about a
// value it did copy.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { clearDisclosureMemory, CopyButton, Details } from './bits.tsx';

// The page's own navigator, with the clipboard as the browser in question has it: a
// browser with none is one whose property is undefined. It is shadowed rather than
// assigned, because the instance's clipboard has a getter and no setter.
const withClipboard = (clipboard: unknown): void => {
  vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: clipboard, configurable: true } }));
};

test('a value that reached the clipboard says so, and one that did not says why instead', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(() => Promise.resolve());
  withClipboard({ writeText });
  const view = render(<CopyButton value="/home/me/.claude" />);
  await user.click(screen.getByRole('button'));
  expect(writeText).toHaveBeenCalledWith('/home/me/.claude');
  expect(screen.getByRole('button')).toHaveTextContent('已复制');
  view.unmount();

  // A browser that refuses the write: nothing was copied, so nothing may say it was.
  withClipboard({ writeText: () => Promise.reject(new Error('权限被拒绝')) });
  render(<CopyButton value="/home/me/.claude" />);
  await user.click(screen.getByRole('button'));
  expect(screen.getByRole('button')).toHaveTextContent('复制不了');
  expect(screen.getByRole('button')).not.toHaveTextContent('已复制');
  expect(screen.getByRole('button')).toHaveAttribute('title', '浏览器不让网页写剪贴板：选中这段文字，自己复制');
  // Trying again is a new attempt, not a success carried over.
  await user.click(screen.getByRole('button'));
  expect(screen.getByRole('button')).toHaveTextContent('复制不了');
});

test('a browser with no clipboard at all is the same refusal, not a claim that it worked', async () => {
  const user = userEvent.setup();
  withClipboard(undefined);
  render(<CopyButton value="/home/me/.claude" />);
  await user.click(screen.getByRole('button'));
  expect(screen.getByRole('button')).toHaveTextContent('复制不了');
  expect(screen.getByRole('button')).not.toHaveTextContent('已复制');
});

test('Details with defaultOpen starts expanded, remembers explicit collapse, and never pollutes memory on mount', async () => {
  clearDisclosureMemory();
  const user = userEvent.setup();

  // Mounting with defaultOpen=true without clicking must not pollute remembered state when defaultOpen later flips false.
  const first = render(
    <Details id="round:test-auto" defaultOpen title={(open) => <span>{open ? '已展开' : '已折叠预览'}</span>}>
      <p>正文内容</p>
    </Details>,
  );
  const firstDetails = screen.getByText('已展开').closest('details')!;
  expect(firstDetails).toHaveAttribute('open');
  first.unmount();

  const second = render(
    <Details id="round:test-auto" defaultOpen={false} title={(open) => <span>{open ? '已展开' : '已折叠预览'}</span>}>
      <p>正文内容</p>
    </Details>,
  );
  expect(screen.getByText('已折叠预览').closest('details')).not.toHaveAttribute('open');
  second.unmount();

  // Explicitly collapsing a defaultOpen section remembers the closed choice across remounts.
  const third = render(
    <Details id="round:test-manual" defaultOpen title={(open) => <span>{open ? '第 4 轮' : '第 4 轮 · 预览'}</span>}>
      <p>第四轮内容</p>
    </Details>,
  );
  const summary = screen.getByText('第 4 轮').closest('summary')!;
  expect(summary.closest('details')).toHaveAttribute('open');
  await user.click(summary);
  expect(summary.closest('details')).not.toHaveAttribute('open');
  expect(screen.getByText('第 4 轮 · 预览')).toBeInTheDocument();
  third.unmount();

  render(
    <Details id="round:test-manual" defaultOpen title={(open) => <span>{open ? '第 4 轮' : '第 4 轮 · 预览'}</span>}>
      <p>第四轮内容</p>
    </Details>,
  );
  expect(screen.getByText('第 4 轮 · 预览').closest('details')).not.toHaveAttribute('open');
  clearDisclosureMemory();
});
