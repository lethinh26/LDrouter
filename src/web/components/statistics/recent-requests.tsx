// Recent requests table with time-ago + green/red status dots.
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { formatNumber, formatTimeAgo } from '../../lib/utils';
import type { LiveRequestShape } from '../../lib/use-live-stats';

interface RecentRequestsProps { rows: LiveRequestShape[] }

export function RecentRequests({ rows }: RecentRequestsProps) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Recent Requests</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No requests yet — traffic will appear here live.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.requestedModel}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.providerName ?? '—'}</TableCell>
                  <TableCell className="text-xs">
                    <span className="font-mono">in {formatNumber(r.inputTokens)} · out {formatNumber(r.outputTokens)}</span>
                    {r.cacheReadTokens > 0 && <span className="ml-1 text-amber-600">(+{formatNumber(r.cacheReadTokens)} cache)</span>}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <span className={r.success ? 'h-2 w-2 rounded-full bg-emerald-400' : 'h-2 w-2 rounded-full bg-red-400'} />
                      <span className="text-xs">{r.success ? r.httpStatus : `${r.httpStatus} err`}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatTimeAgo(r.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
