// Sidebar with primary navigation.
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { cn } from '../lib/utils';
import { adminNavigationItems } from '../lib/admin-navigation';
import { api } from '../lib/api';

export function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {adminNavigationItems.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          onClick={onNavigate}
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
    </>
  );
}

export function Sidebar() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ appVersion?: string }>('/api/admin/settings/system')
      .then((data) => {
        if (!cancelled && data.appVersion) setVersion(data.appVersion);
      })
      .catch(() => { /* keep placeholder */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <aside className="hidden w-60 shrink-0 border-r bg-sidebar text-sidebar-foreground md:flex md:flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <img src="/logo.png" alt="LateDev Router" className="h-7 w-7 object-contain" />
        <div className="font-semibold tracking-tight">LateDev Router</div>
      </div>
      <nav aria-label="Primary navigation" className="flex-1 space-y-0.5 p-2">
        <SidebarLinks />
      </nav>
      <div className="border-t p-3 text-xs text-muted-foreground flex items-center gap-2">
        <ShieldCheck className="h-3.5 w-3.5 text-primary" /> {version ? `v${version}` : 'v…'}
      </div>
    </aside>
  );
}
