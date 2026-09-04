// Debug logging utilities for request lifecycle tracking

import { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

const DEBUG_LOG_DIR = '/data';
const DEBUG_LOG_FILE = path.join(DEBUG_LOG_DIR, 'ldrouter-debug.log');

// Ensure log file exists
if (!fs.existsSync(DEBUG_LOG_FILE)) {
  try {
    fs.writeFileSync(DEBUG_LOG_FILE, '');
  } catch (_err) {
    // Silent fail - don't break the application
    console.error('Failed to create debug log:', _err);
  }
}

interface DebugLogEntry {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  requestId: string;
  url: string;
  method: string;
  phase: string;
  details: unknown;
}

export function appendDebugLog(entry: DebugLogEntry): void {
  const logLine = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(DEBUG_LOG_FILE, logLine);
  } catch (_err) {
    // Silent fail - don't break the application
    console.error('Failed to write debug log:', _err);
  }
}

export function registerDebugHook(app: FastifyInstance): void {
  // Log every request entering the system
  app.addHook('onRequest', async (req, _reply) => {
    const entry: DebugLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      requestId: req.id as string,
      url: req.url,
      method: req.method,
      phase: 'REQUEST_ENTERED',
      details: {
        headers: {
          authorization: req.headers.authorization ? '[REDACTED]' : undefined,
          'content-type': req.headers['content-type'],
        },
      },
    };
    appendDebugLog(entry);
  });

  // Log before route handler execution
  app.addHook('preHandler', async (req, _reply) => {
    const entry: DebugLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      requestId: req.id as string,
      url: req.url,
      method: req.method,
      phase: 'ROUTE_MATCHED',
      details: {},
    };
    appendDebugLog(entry);
  });

  // Log response completion with status code and content type
  app.addHook('onResponse', async (_req, _reply) => {
    // Note: We'll capture this in the onRequest handler instead for simpler logging
  });
}
