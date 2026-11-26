import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { ConsoleVersionNotice } from './console-version-notice';

test.each([
  ['0.1.711', '0.1.711'], ['0.1.711', undefined], ['0.1.711', ''],
  ['0.1.711', 'unknown'], ['0.1.711', '0.1'], ['0.1.711', '0.1.712 开发版'],
  ['0.1 开发版', '0.1.712'], ['', '0.1.712'],
])('only known differing release versions can request a refresh: page %s, service %s', (pageVersion, serviceVersion) => {
  const onRefresh = vi.fn();
  render(<ConsoleVersionNotice pageVersion={pageVersion!} serviceVersion={serviceVersion} onRefresh={onRefresh} />);
  expect(screen.queryByRole('status', { name: '页面版本提示' })).toBeNull();
  expect(onRefresh).not.toHaveBeenCalled();
});

test('a release change asks the owner to preserve drafts and refresh; rollback also prompts without automatic reload', async () => {
  const onRefresh = vi.fn();
  const view = render(<ConsoleVersionNotice pageVersion="0.1.711" serviceVersion="0.1.712" onRefresh={onRefresh} />);
  expect(screen.getByRole('status', { name: '页面版本提示' })).toHaveTextContent('页面需要刷新');
  expect(screen.getByText(/先保存未发送的内容/)).toBeInTheDocument();
  expect(onRefresh).not.toHaveBeenCalled();
  view.rerender(<ConsoleVersionNotice pageVersion="0.1.711" serviceVersion="0.1.700" onRefresh={onRefresh} />);
  expect(screen.getByRole('status', { name: '页面版本提示' })).toHaveTextContent('0.1.700');
  expect(onRefresh).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新页面' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});
