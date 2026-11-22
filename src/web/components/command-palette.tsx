import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { cn } from '../lib/utils';
import { adminNavigationItems } from '../lib/admin-navigation';
import type { AdminNavigationItem } from '../lib/admin-navigation';

export function CommandPalette({ open, onOpenChange, returnFocusRef, fallbackFocusRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return adminNavigationItems;
    return adminNavigationItems.filter((command) => `${command.label} ${command.description} ${command.keywords}`.toLowerCase().includes(normalized));
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  const selectCommand = (command: AdminNavigationItem | undefined) => {
    if (!command) return;
    onOpenChange(false);
    navigate(command.to);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => {
          const originalTarget = returnFocusRef.current;
          const target = originalTarget?.isConnected ? originalTarget : fallbackFocusRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search and navigate to an administration page.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            autoFocus
            role="combobox"
            aria-label="Search pages"
            aria-controls="command-palette-results"
            aria-activedescendant={filtered[activeIndex] ? `command-${filtered[activeIndex].to}` : undefined}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            className="h-12 border-0 px-0 shadow-none focus-visible:ring-0"
            placeholder="Search pages and settings…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && filtered.length) {
                event.preventDefault();
                setActiveIndex((index) => (index + 1) % filtered.length);
              } else if (event.key === 'ArrowUp' && filtered.length) {
                event.preventDefault();
                setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length);
              } else if (event.key === 'Enter' && filtered[activeIndex]) {
                event.preventDefault();
                selectCommand(filtered[activeIndex]);
              }
            }}
          />
          <kbd className="hidden rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">ESC</kbd>
        </div>
        <div id="command-palette-results" role="listbox" aria-label="Navigation results" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
          {filtered.map((command, index) => {
            const Icon = command.icon;
            return (
              <div
                id={`command-${command.to}`}
                key={command.to}
                role="option"
                aria-selected={activeIndex === index}
                className={cn('flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors', activeIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60')}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectCommand(command)}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"><Icon className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{command.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{command.description}</span>
                </span>
                <span className="text-[10px] text-muted-foreground">↵</span>
              </div>
            );
          })}
        </div>
        {!filtered.length && (
          <div role="status" aria-live="polite" aria-atomic="true" className="px-3 py-10 text-center">
            <p className="text-sm font-medium">No matching pages</p>
            <p className="mt-1 text-xs text-muted-foreground">Try another page name or keyword.</p>
          </div>
        )}
        <div className="flex items-center gap-4 border-t bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
          <span><kbd className="rounded border bg-background px-1">↑</kbd> <kbd className="rounded border bg-background px-1">↓</kbd> to navigate</span>
          <span><kbd className="rounded border bg-background px-1">Enter</kbd> to open</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
