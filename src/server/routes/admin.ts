// Admin API routes (mounted at /api/admin/*). All require admin session auth.

import type { FastifyInstance } from 'fastify';
import { registerSetupRoutes } from './admin/setup';
import { registerAuthRoutes } from './admin/auth';
import { registerProviderRoutes } from './admin/providers';
import { registerModelRoutes } from './admin/models';
import { registerComboRoutes } from './admin/combos';
import { registerAliasRoutes } from './admin/aliases';
import { registerApiKeyRoutes } from './admin/api-keys';
import { registerRequestRoutes } from './admin/requests';
import { registerStatsRoutes } from './admin/stats';
import { registerAuditRoutes } from './admin/audit';
import { registerSettingsRoutes } from './admin/settings';
import { registerBackupRoutes } from './admin/backup';
import { registerDashboardRoutes } from './admin/dashboard';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Setup routes are always reachable (used on first run).
  await app.register(async (instance) => {
    await registerSetupRoutes(instance);
  });

  // Auth routes (login/logout) are public and must NOT inherit the
  // requireAdminAuth hook that the authenticated scope below adds.
  await app.register(async (instance) => {
    await registerAuthRoutes(instance);
  });

  // Authenticated admin routes
  await app.register(async (instance) => {
    await registerProviderRoutes(instance);
    await registerModelRoutes(instance);
    await registerComboRoutes(instance);
    await registerAliasRoutes(instance);
    await registerApiKeyRoutes(instance);
    await registerRequestRoutes(instance);
    await registerStatsRoutes(instance);
    await registerAuditRoutes(instance);
    await registerSettingsRoutes(instance);
    await registerBackupRoutes(instance);
    await registerDashboardRoutes(instance);
  });
}
