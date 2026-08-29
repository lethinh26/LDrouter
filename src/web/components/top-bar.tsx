// Top bar with theme toggle and user menu.
import { LogOut, Moon, Sun, Monitor } from 'lucide-react';
import { Button } from './ui/button';
import { useTheme } from './theme-provider';
import { useAuth } from '../app/auth';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { useState } from 'react';

export function TopBar() {
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <div className="text-sm text-muted-foreground">Admin</div>
      <div className="flex items-center gap-2">
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
