// Login x Tier competence & cost evidence report (shared contract between service and console).
// Pure types, labels, and deterministic advice rules — zero runtime dependencies.
import { localeMap, t } from './i18n.ts';

export type CompetenceAdviceKind = 'promote' | 'steady' | 'caution' | 'insufficient';

export interface CompetenceAdvice {
  kind: CompetenceAdviceKind;
  reason: string;
}

export interface CompetenceRow {
  login_id: string | null;
  login_name: string;
  executor: string;
  tier: string;
  rounds: number;
  completed_rounds: number;
  failed_rounds: number;
  reviewed_rounds: number;
  first_pass_count: number;
  rework_count: number;
  escalated_count: number;
  first_pass_rate: number | null; // null when reviewed_rounds === 0
  failure_rate: number;           // failed_rounds / rounds (0..1)
  avg_duration_ms: number | null; // null when no runs have valid start/end duration
  total_tokens: number;
  list_cost_usd: number;
  unpriced_rounds: number;
  advice: CompetenceAdvice;
}

export interface CompetenceReport {
  from: string;
  to: string;
  min_sample_size: number; // 5
  rows: CompetenceRow[];
  summary: {
    total_rounds: number;
    reviewed_rounds: number;
    escalated_rounds: number;
    total_list_cost_usd: number;
  };
}

export const COMPETENCE_MIN_SAMPLE_SIZE = 5;

export const COMPETENCE_ADVICE_LABELS: Readonly<Record<CompetenceAdviceKind, string>> = localeMap({
  promote: 'sh.competence.advice.promote',
  steady: 'sh.competence.advice.steady',
  caution: 'sh.competence.advice.caution',
  insufficient: 'sh.competence.advice.insufficient',
});

export function competenceAdvice(
  metrics: Pick<CompetenceRow, 'reviewed_rounds' | 'first_pass_rate' | 'escalated_count'>,
  minSampleSize: number = COMPETENCE_MIN_SAMPLE_SIZE,
): CompetenceAdvice {
  if (metrics.reviewed_rounds < minSampleSize) {
    return {
      kind: 'insufficient',
      reason: t('sh.competence.reason.insufficient', { minSampleSize }),
    };
  }
  if (metrics.first_pass_rate !== null && metrics.first_pass_rate >= 0.85 && metrics.escalated_count === 0) {
    return {
      kind: 'promote',
      reason: t('sh.competence.reason.promote'),
    };
  }
  if ((metrics.first_pass_rate !== null && metrics.first_pass_rate < 0.6) || metrics.escalated_count >= 2) {
    return {
      kind: 'caution',
      reason: t('sh.competence.reason.caution'),
    };
  }
  return {
    kind: 'steady',
    reason: t('sh.competence.reason.steady'),
  };
}
