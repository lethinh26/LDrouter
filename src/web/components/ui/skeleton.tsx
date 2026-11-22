// Shared skeleton placeholder and page header used across the admin UI.
import * as React from 'react';
import { cn } from '../../lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)} {...props} />;
}

export function PageHeader({ title, description, actions, className }: { title: string; description?: string; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-6 flex items-start justify-between gap-4', className)}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
