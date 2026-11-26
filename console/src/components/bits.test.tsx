// Guards the small pieces every page is made of: a copy button that says 已复制 when the
// browser refused the write (or has no clipboard at all), and one that stays quiet about a
// value it did copy.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { CopyButton } from './bits.tsx';

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
