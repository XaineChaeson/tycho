import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ErrorBoundary } from './app';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('渲染崩溃示例');
  return <div>正常内容</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('ErrorBoundary renders Chinese recovery panel instead of blank screen and recovers to overview', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.location.hash = '#/knowledge';

  const { rerender } = render(
    <ErrorBoundary>
      <Bomb shouldThrow />
    </ErrorBoundary>,
  );

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('页面渲染遇到异常');
  expect(alert).toHaveTextContent('渲染崩溃示例');
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
  const goHome = screen.getByRole('button', { name: '返回总览' });
  expect(goHome).toBeInTheDocument();

  rerender(
    <ErrorBoundary>
      <Bomb shouldThrow={false} />
    </ErrorBoundary>,
  );
  fireEvent.click(goHome);

  expect(window.location.hash).toBe('#/');
  expect(screen.getByText('正常内容')).toBeInTheDocument();
});
