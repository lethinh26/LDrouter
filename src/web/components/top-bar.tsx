// Top bar with theme toggle, user menu, and update notifications.
import { LogOut, Moon, Sun, Monitor, ArrowUpCircle } from 'lucide-react';
import { Button } from './ui/button';
import { useTheme } from './theme-provider';
import { useAuth } from '../app/auth';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useNavigate } from 'react-router-dom';

interface UpdateStatus {
  latestVersion: string | null;
  hasUpdate: boolean;
  checkedAt: string;
}

export function TopBar() {
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null);
  const navigate = useNavigate();
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  // Check for updates when mounted
  useEffect(() => {
    api.get<UpdateStatus>('/api/admin/update/check')
      .then((r) => setUpdateInfo(r))
      .catch(() => {});
  }, []);

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <div className="text-sm text-muted-foreground">Admin</div>
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

        <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
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
    </header>
  );
}
