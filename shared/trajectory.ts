import { localeMap } from './i18n.ts';

export const ROUTER_RECEIPT = 'tycho.dev/call-id';

export const ROUTER_CALL_RESULT_TEXT = localeMap({
  returned: 'sh.trajectory.callResult.returned',
  refused: 'sh.trajectory.callResult.refused',
  failed: 'sh.trajectory.callResult.failed',
  interrupted: 'sh.trajectory.callResult.interrupted',
});

export interface RouterCallTrace {
  id: string;
  name: string;
  message_ids: string[];
  started_at: string;
  request: string | null;
  result: string | null;
  result_state: 'returned' | 'refused' | 'interrupted' | 'failed' | null;
  finished_at: string | null;
  receipt_confirmed: boolean;
  committed: { action: string; task_id: string | null; run_id: string | null; at: string }[];
}

export type RouterExchangeOutcome = 'completed' | 'failed' | 'interrupted' | 'exited' | 'not_sent';

export interface RouterToolCatalog {
  basis: 'service_available';
  tools: { name: string; description: string; inputSchema: unknown }[];
}

export interface RouterTurnTrace {
  message_id: string;
  turn_message_id: string;
  exchanges: {
    id: string;
    phase: 'material' | 'request';
    started_at: string;
    finished_at: string | null;
    outcome: RouterExchangeOutcome | null;
    template: string;
    tool_catalog: RouterToolCatalog | null;
    input: string;
    output: string | null;
  }[];
  calls: RouterCallTrace[];
  next_call: string | null;
}
