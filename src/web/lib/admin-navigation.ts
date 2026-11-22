import { Activity, Boxes, Code2, Cog, FileText, Gauge, KeyRound, Layers, Network, ScrollText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface AdminNavigationItem {
  to: string;
  label: string;
  description: string;
  keywords: string;
  icon: LucideIcon;
  end?: boolean;
}

/** Single source of truth for the sidebar, mobile drawer, page titles and command palette. */
export const adminNavigationItems: readonly AdminNavigationItem[] = [
  { to: '/', label: 'Dashboard', description: 'Operational overview', keywords: 'home overview metrics', icon: Gauge, end: true },
  { to: '/providers', label: 'Providers', description: 'Manage upstream connections', keywords: 'upstream connection credentials', icon: Network },
  { to: '/models', label: 'Models', description: 'Browse imported models', keywords: 'model catalog', icon: Boxes },
  { to: '/combos', label: 'Combos', description: 'Configure fallback and routing groups', keywords: 'fallback routing', icon: Layers },
  { to: '/aliases', label: 'Aliases', description: 'Manage public model aliases', keywords: 'model mapping', icon: Code2 },
  { to: '/api-keys', label: 'API Keys', description: 'Manage access keys and limits', keywords: 'tokens credentials access', icon: KeyRound },
  { to: '/requests', label: 'Requests', description: 'Inspect request history and failures', keywords: 'logs errors traffic', icon: Activity },
  { to: '/statistics', label: 'Statistics', description: 'Review traffic and performance', keywords: 'analytics charts latency', icon: FileText },
  { to: '/audit', label: 'Audit Logs', description: 'Review administrative activity', keywords: 'security events history', icon: ScrollText },
  { to: '/settings', label: 'Settings', description: 'Configure security and system behavior', keywords: 'preferences configuration', icon: Cog },
];

export function getAdminPageTitle(pathname: string): string {
  const page = adminNavigationItems.find((item) =>
    item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)
  );
  return page?.label ?? 'Admin';
}
