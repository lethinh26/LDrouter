// Top bar with theme toggle, user menu, and update notifications.
import { LogOut, Moon, Sun, Monitor, ArrowUpCircle, Menu, Search } from 'lucide-react';
import { Button } from './ui/button';
import { useTheme } from './theme-provider';
import { useAuth } from '../app/auth';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import { api } from '../lib/api';
import { useLocation, useNavigate } from 'react-router-dom';
import { CommandPalette } from './command-palette';
import { getAdminPageTitle } from '../lib/admin-navigation';

interface UpdateStatus {
  latestVersion: string | null;
  hasUpdate: boolean;
  checkedAt: string;
}

export function TopBar({ onOpenNavigation, commandFallbackFocusRef }: {
  onOpenNavigation: () => void;
  commandFallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const commandReturnFocusRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const pageTitle = getAdminPageTitle(location.pathname);

  const openCommandPalette = useCallback(() => {
    if (commandOpen) return;
    const active = document.activeElement;
    commandReturnFocusRef.current = active instanceof HTMLElement ? active : null;
    setCommandOpen(true);
  }, [commandOpen]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openCommandPalette();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [openCommandPalette]);

  // Check for updates when mounted
  useEffect(() => {
    let cancelled = false;
    api.get<UpdateStatus>('/api/admin/update/check?force=1')
      .then((r) => { if (!cancelled) setUpdateInfo(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <header className="flex h-14 items-center justify-between gap-3 border-b bg-background px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenNavigation} aria-label="Open navigation">
          <Menu className="h-4 w-4" />
        </Button>
        <div className="min-w-0 truncate text-sm font-medium">{pageTitle}</div>
        <Button variant="outline" size="sm" className="hidden h-8 gap-2 sm:inline-flex" onClick={openCommandPalette} aria-label="Search pages and settings">
          <Search className="h-3.5 w-3.5" />
          <span>Search</span>
          <kbd className="ml-2 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Ctrl / ⌘ K</kbd>
        </Button>
        <Button variant="ghost" size="icon" className="sm:hidden" onClick={openCommandPalette} aria-label="Search pages and settings">
          <Search className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        {/* Update notification badge */}
        {updateInfo?.hasUpdate && (
          <Button
            variant="ghost"
            size="sm"
            title={`New version available: v${updateInfo.latestVersion} — go to Settings → System to update`}
            onClick={() => navigate('/settings?tab=system')}
          >
            <ArrowUpCircle className="mr-1 h-4 w-4 text-blue-500" />
            Update v{updateInfo.latestVersion}
          </Button>
        )}

        <Button variant="ghost" size="icon" aria-label="Toggle color theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          <ThemeIcon className="h-4 w-4" />
        </Button>
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost">{user?.username ?? 'admin'}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void logout()}>
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        returnFocusRef={commandReturnFocusRef}
        fallbackFocusRef={commandFallbackFocusRef}
      />
    </header>
  );
}
