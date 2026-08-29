// Sidebar with primary navigation.
import { NavLink } from 'react-router-dom';
import { Activity, Boxes, Code2, Cog, FileText, Gauge, KeyRound, Layers, Network, ScrollText, ShieldCheck } from 'lucide-react';
import { cn } from '../lib/utils';

const items = [
  { to: '/', label: 'Dashboard', icon: Gauge, end: true },
  { to: '/providers', label: 'Providers', icon: Network },
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/combos', label: 'Combos', icon: Layers },
  { to: '/aliases', label: 'Aliases', icon: Code2 },
  { to: '/api-keys', label: 'API Keys', icon: KeyRound },
  { to: '/requests', label: 'Requests', icon: Activity },
  { to: '/statistics', label: 'Statistics', icon: FileText },
  { to: '/audit', label: 'Audit Logs', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: Cog },
];

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 border-r bg-sidebar text-sidebar-foreground md:flex md:flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <img src="/logo.png" alt="LateDev Router" className="h-7 w-7 object-contain" />
        <div className="font-semibold tracking-tight">LateDev Router</div>
      </div>
      <nav className="flex-1 space-y-0.5 p-2">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                isActive ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )
            }
          >
            <it.icon className="h-4 w-4" />
            {it.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t p-3 text-xs text-muted-foreground flex items-center gap-2">
        <ShieldCheck className="h-3.5 w-3.5 text-primary" /> v0.1.0
      </div>
    </aside>
  );
}
