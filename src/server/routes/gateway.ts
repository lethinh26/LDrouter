// Gateway public API routes (mounted at /v1/*). Auth via ld-.. API keys.

import type { FastifyInstance } from 'fastify';
import { registerOpenAIRoutes } from './gateway/openai';
import { registerAnthropicRoutes } from './gateway/anthropic';

export async function registerGatewayRoutes(app: FastifyInstance): Promise<void> {
  await registerOpenAIRoutes(app);
  await registerAnthropicRoutes(app);
}
