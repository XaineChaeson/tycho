// The console's places, in the order the owner most often goes to them: what waits and
// what moves first, then what is set up once and looked at now and then. The side column
// and the palette both read this list; a project is a place too, and is listed by name.
import { BookOpen, ChartColumn, Inbox, KeyRound, ListChecks, Radio, Server, Settings, Shapes, type LucideIcon } from 'lucide-react';
import { t } from '@shared/i18n.ts';
import type { MessageKey } from '@/lib/i18n';

export interface Place { to: string; readonly title: string; titleKey: MessageKey; icon: LucideIcon }

function place(to: string, titleKey: MessageKey, icon: LucideIcon): Place {
  return {
    to,
    titleKey,
    icon,
    get title() {
      return t(titleKey);
    },
  };
}

export const WORK_PLACES: readonly Place[] = [
  place('/', 'nav.overview', Inbox),
  place('/work', 'nav.work', ListChecks),
  place('/usage', 'nav.usage', ChartColumn),
];

export const SETUP_PLACES: readonly Place[] = [
  place('/knowledge', 'nav.knowledge', BookOpen),
  place('/roles', 'nav.roles', Shapes),
  place('/accounts', 'nav.accounts', KeyRound),
  place('/machines', 'nav.machines', Server),
  place('/inbound', 'nav.inbound', Radio),
  place('/settings', 'nav.settings', Settings),
];

export const PLACES: readonly Place[] = [...WORK_PLACES, ...SETUP_PLACES];
