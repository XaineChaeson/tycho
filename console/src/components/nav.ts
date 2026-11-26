// The console's places, in the order the owner most often goes to them: what waits and
// what moves first, then what is set up once and looked at now and then. The side column
// and the palette both read this list; a project is a place too, and is listed by name.
import { BookOpen, ChartColumn, Inbox, KeyRound, ListChecks, Radio, Server, Settings, Shapes, type LucideIcon } from 'lucide-react';

export interface Place { to: string; title: string; icon: LucideIcon }

export const WORK_PLACES: readonly Place[] = [
  { to: '/', title: '总览', icon: Inbox },
  { to: '/work', title: '工作', icon: ListChecks },
  { to: '/usage', title: '用量', icon: ChartColumn },
];

export const SETUP_PLACES: readonly Place[] = [
  { to: '/knowledge', title: '知识', icon: BookOpen },
  { to: '/roles', title: '职能', icon: Shapes },
  { to: '/accounts', title: '账号', icon: KeyRound },
  { to: '/machines', title: '机器', icon: Server },
  { to: '/inbound', title: '入站来源', icon: Radio },
  { to: '/settings', title: '设置', icon: Settings },
];

export const PLACES: readonly Place[] = [...WORK_PLACES, ...SETUP_PLACES];
