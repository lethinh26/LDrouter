// Codex model import: discovers models from the Codex account pool and imports the selected ones.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Badge } from './ui/badge';

interface Discovered { upstreamId: string; displayName: string; alreadyImported: boolean }

export function CodexDiscoverDialog({ providerId, providerName, open, onOpenChange, onImported }: { providerId: string; providerName: string; open: boolean; onOpenChange: (open: boolean) => void; onImported: () => void }) {
  const [models, setModels] = useState<Discovered[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fetchModels = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await api.post<{ models: Discovered[] }>(`/api/admin/providers/${providerId}/discover`);
      setModels(result.models);
      setSelected(new Set(result.models.filter((m) => !m.alreadyImported).map((m) => m.upstreamId)));
    } catch (e) { setError((e as Error).message || 'Unable to fetch Codex models'); }
    finally { setLoading(false); }
  }, [providerId]);
  useEffect(() => { void fetchModels(); }, [fetchModels]);

  const filtered = models.filter((m) => !search || m.upstreamId.toLowerCase().includes(search.toLowerCase()) || m.displayName.toLowerCase().includes(search.toLowerCase()));

  const runImport = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.post<{ imported: number; requested: number }>('/api/admin/models/import', { providerId, modelIds: Array.from(selected) });
      toast.success(`Imported ${result.imported} of ${result.requested} Codex models`);
      onOpenChange(false);
      onImported();
    } catch (e) { setError((e as Error).message || 'Unable to import models'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import models from {providerName}</DialogTitle>
          <DialogDescription>Models are read from the Codex account pool. Nothing is added until you confirm.</DialogDescription>
        </DialogHeader>
        {loading ? <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Fetching models…</p> : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <span className="shrink-0 text-sm text-muted-foreground">{filtered.length} / {models.length} · {selected.size} selected</span>
              <Button variant="outline" size="sm" onClick={() => setSelected(new Set(filtered.filter((m) => !m.alreadyImported).map((m) => m.upstreamId)))}>Select All (new)</Button>
            </div>
            <div className="max-h-80 overflow-auto rounded-md border">
              {filtered.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{models.length === 0 ? 'The Codex account returned no models.' : 'No model matches your search.'}</p> : filtered.map((m) => (
                <label key={m.upstreamId} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-0 hover:bg-accent">
                  <Checkbox checked={selected.has(m.upstreamId)} disabled={m.alreadyImported} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked === true) next.add(m.upstreamId); else next.delete(m.upstreamId); return next; })} />
                  <span className="flex-1 text-sm">{m.displayName}</span>
                  <span className="font-mono text-xs text-muted-foreground">{m.upstreamId}</span>
                  {m.alreadyImported && <Badge variant="secondary">imported</Badge>}
                </label>
              ))}
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => void fetchModels()} disabled={loading}>Refetch</Button>
          <Button disabled={busy || selected.size === 0} onClick={() => void runImport()}>Import {selected.size || ''}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
