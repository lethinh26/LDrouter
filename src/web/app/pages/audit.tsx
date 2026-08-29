// Audit logs page.
import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';

interface Row { id: string; createdAt: string; action: string; actor: string; ip: string; success: boolean; targetType: string | null; targetId: string | null; targetName: string | null; metadata: Record<string, unknown>; }

export function AuditLogs() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  useEffect(() => { api.get<{ total: number; rows: Row[] }>('/api/admin/audit?limit=200').then((r) => { setRows(r.rows); setTotal(r.total); }); }, []);
  return (
    <div>
      <PageHeader title="Audit Logs" description={`${total} entries · immutable`} />
      <Card>
        <CardHeader><CardTitle className="text-base">All entries</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Time</TableHead><TableHead>Action</TableHead><TableHead>Status</TableHead><TableHead>Target</TableHead><TableHead>IP</TableHead><TableHead>Actor</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No audit events yet.</TableCell></TableRow>}
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.action}</TableCell>
                  <TableCell>{r.success ? <Badge variant="success">ok</Badge> : <Badge variant="destructive">fail</Badge>}</TableCell>
                  <TableCell className="text-xs">{r.targetName ?? r.targetId ?? '—'}</TableCell>
                  <TableCell className="text-xs">{r.ip}</TableCell>
                  <TableCell className="text-xs">{r.actor}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
