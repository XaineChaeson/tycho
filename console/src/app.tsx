import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Component, useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Route, Routes, useParams } from 'react-router';
import { Shell } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { createLive } from '@/lib/live';
import { LiveContext } from '@/lib/live-context';
import { AccountsPage } from '@/pages/accounts';
import { HomePage } from '@/pages/home';
import { InboundPage } from '@/pages/inbound';
import { KnowledgePage } from '@/pages/knowledge';
import { EntryPage } from '@/pages/knowledge-entry';
import { ProposalPage } from '@/pages/knowledge-proposal';
import { MachinesPage } from '@/pages/machines';
import { LegacyPage, ProjectPage } from '@/pages/project';
import { ProjectsPage } from '@/pages/projects';
import { RolesPage } from '@/pages/roles';
import { SettingsPage } from '@/pages/settings';
import { TaskPage } from '@/pages/task';
import { UsagePage } from '@/pages/usage';
import { WorkPage } from '@/pages/work';
import { WorkListPage } from '@/pages/work-list';

// A page of another project, work or task starts from nothing: its drafts, its selected Run
// and its place on the page belong to the one it was opened for.
function Keyed({ page: Page }: { page: (props: { id: string }) => React.ReactNode }) {
  const { id = '' } = useParams();
  return <Page key={id} id={id} />;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleGoHome = () => {
    window.location.hash = '#/';
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="flex min-h-screen items-center justify-center bg-canvas p-6 text-foreground">
          <div className="grid w-full max-w-md gap-4 rounded-xl border border-border bg-raised p-6 shadow-card">
            <div className="grid gap-1.5">
              <h1 className="text-base font-semibold">页面渲染遇到异常</h1>
              <p className="text-sm text-muted-foreground wrap-anywhere">
                {this.state.error.message || '发生了未预期的渲染错误。'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="primary" size="sm" onClick={this.handleReload}>
                刷新页面
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={this.handleGoHome}>
                返回总览
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  // A read that fails says so on the page and is tried again by the page's own rhythm:
  // nothing is retried behind the owner's back.
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
  const [live] = useState(() => createLive({ client }));

  useEffect(() => {
    live.start();
    return () => live.stop();
  }, [live]);

  return (
    <QueryClientProvider client={client}>
      <LiveContext value={live}>
        <ErrorBoundary>
          <HashRouter>
            <Routes>
              <Route element={<Shell />}>
                <Route path="/work" element={<WorkListPage />} />
                <Route path="/work/:id" element={<Keyed page={WorkPage} />} />
                <Route path="/task/:id" element={<Keyed page={TaskPage} />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/projects/:id/:tab?" element={<Keyed page={ProjectPage} />} />
                <Route path="/legacy" element={<LegacyPage />} />
                <Route path="/roles" element={<RolesPage />} />
                <Route path="/inbound" element={<InboundPage />} />
                <Route path="/knowledge" element={<KnowledgePage />} />
                <Route path="/knowledge/proposals/:id" element={<Keyed page={ProposalPage} />} />
                <Route path="/knowledge/entries/:id" element={<Keyed page={EntryPage} />} />
                <Route path="/settings/:place?" element={<SettingsPage />} />
                <Route path="/accounts" element={<AccountsPage />} />
                <Route path="/machines" element={<MachinesPage />} />
                <Route path="/usage" element={<UsagePage />} />
                {/* Any other address is the overview: what waits, what moves, what just ended. */}
                <Route path="*" element={<HomePage />} />
              </Route>
            </Routes>
          </HashRouter>
        </ErrorBoundary>
      </LiveContext>
    </QueryClientProvider>
  );
}
