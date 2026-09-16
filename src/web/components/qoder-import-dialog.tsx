// Qoder token import: paste `pt-…` lines or upload a .txt/.json file, preview, then import the
// selected records. The token is never rendered back — only the masked form the API returns.
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

interface PreviewRecord { index: number; source?: string; valid: boolean; personalTokenMasked?: string; label?: string | null; duplicateOf?: string | null; error?: string }
interface PreviewResponse { records: PreviewRecord[]; validCount: number; invalidCount: number }
interface ImportResponse { added: number; updated: number; skipped: number; failed: number }

export function QoderImportDialog({ providerId, open, onOpenChange, onImported }: { providerId: string; open: boolean; onOpenChange: (open: boolean) => void; onImported: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const makeForm = (indexes?: number[]) => {
    const form = new FormData();
    form.append('providerId', providerId);
    if (indexes) form.append('selectedIndexes', JSON.stringify(indexes));
    files.forEach((file) => form.append('file', file));
    if (paste.trim()) form.append('text', paste);
    return form;
  };
  const previewImport = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.upload<PreviewResponse>('/api/admin/qoder/accounts/preview', makeForm());
      setPreview(result);
      setSelected(result.records.filter((record) => record.valid && !record.duplicateOf).map((record) => record.index));
    } catch (e) { setError((e as Error).message || 'Unable to preview import'); }
    finally { setBusy(false); }
  };
  const importSelected = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.upload<ImportResponse>('/api/admin/qoder/accounts/import', makeForm(selected));
      onOpenChange(false); onImported();
      setFiles([]); setPaste(''); setPreview(null); setSelected([]);
      toast.success(`${result.added} added, ${result.updated} updated, ${result.failed} failed`);
    } catch (e) { setError((e as Error).message || 'Unable to import tokens'); }
    finally { setBusy(false); }
  };
  const toggle = (index: number, checked: boolean | 'indeterminate') => setSelected((current) => checked === true ? [...new Set([...current, index])] : current.filter((item) => item !== index));
  const selectable = preview?.records.filter((record) => record.valid && !record.duplicateOf).map((record) => record.index) ?? [];
  const allSelected = selectable.length > 0 && selectable.every((index) => selected.includes(index));

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-3xl">
      <DialogHeader><DialogTitle>Import Qoder personal access tokens</DialogTitle><DialogDescription>One token per line, or a .txt/.json file. Tokens are submitted without being displayed back.</DialogDescription></DialogHeader>
      {!preview ? <div className="space-y-4">
        <div><Label htmlFor="qoder-files">Token files (.txt / .json)</Label><Input id="qoder-files" type="file" accept=".txt,.json,.jsonl,text/plain,application/json" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /></div>
        <div><Label htmlFor="qoder-paste">Paste tokens (optional)</Label><Textarea id="qoder-paste" value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="pt-…" className="min-h-32 font-mono text-xs" /></div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || (files.length === 0 && !paste.trim())} onClick={() => void previewImport()}>{busy ? 'Reading…' : 'Preview import'}</Button></DialogFooter>
      </div> : <div className="space-y-3">
        <div className="flex items-center justify-between rounded-md border p-3 text-sm"><span>{preview.validCount} valid, {preview.invalidCount} invalid</span><label className="flex items-center gap-2"><Checkbox checked={allSelected} onCheckedChange={(checked) => setSelected(checked === true ? selectable : [])} aria-label="Select all valid tokens" /> Select all valid</label></div>
        <div className="max-h-80 overflow-auto rounded-md border"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">Select</th><th className="p-2">Token</th><th className="p-2">Label</th><th className="p-2">Result</th></tr></thead><tbody>{preview.records.map((record) => <tr key={`${record.index}-${record.source ?? ''}`} className="border-b last:border-0"><td className="p-2"><Checkbox checked={selected.includes(record.index)} disabled={!record.valid || !!record.duplicateOf} onCheckedChange={(checked) => toggle(record.index, checked)} aria-label={`Select record ${record.index + 1}`} /></td><td className="p-2 font-mono text-xs">{record.personalTokenMasked || '—'}</td><td className="p-2">{record.label || '—'}</td><td className="p-2">{record.valid ? record.duplicateOf ? <span className="text-amber-600">Already added</span> : <span className="text-emerald-600">Ready</span> : <span className="text-destructive">{record.error || 'Invalid token'}</span>}</td></tr>)}</tbody></table></div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => setPreview(null)}>Back</Button><Button disabled={busy || selected.length === 0} onClick={() => void importSelected()}>{busy ? 'Importing…' : `Import ${selected.length} token${selected.length === 1 ? '' : 's'}`}</Button></DialogFooter>
      </div>}
    </DialogContent>
  </Dialog>;
}
