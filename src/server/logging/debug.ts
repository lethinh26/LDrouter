// Debug logging utilities for request lifecycle tracking

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

const DEBUG_LOG_DIR = '/data';
const DEBUG_LOG_FILE = path.join(DEBUG_LOG_DIR, 'ldrouter-debug.log');

// Ensure log file exists
if (!fs.existsSync(DEBUG_LOG_FILE)) {
  try {
    fs.writeFileSync(DEBUG_LOG_FILE, '');
  } catch (err) {
    console.error('Failed to create debug log:', err);
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
  } catch (err) {
    // Silent fail - don't break the application
    console.error('Failed to write debug log:', err);
  }
}

export function clearDebugLog(): void {
  try {
    fs.writeFileSync(DEBUG_LOG_FILE, '');
    console.log('🗑️  Debug log cleared');
  } catch (err) {
    console.error('Failed to clear debug log:', err);
  }
}

export function getDebugLogContent(): string {
  try {
    return fs.readFileSync(DEBUG_LOG_FILE, 'utf8');
  } catch (err) {
    return '';
  }
}

export function registerDebugHook(app: FastifyInstance): void {
  // Log every request entering the system
  app.addHook('onRequest', async (req, reply) => {
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
  app.addHook('preHandler', async (req, reply) => {
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
  app.addHook('onResponse', async (req, reply) => {
    const statusCode = reply.raw.statusCode;
    const contentType = reply.getHeader('Content-Type') || reply.getHeader('content-type');

    const entry: DebugLogEntry = {
      timestamp: new Date().toISOString(),
      level: statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO',
      requestId: req.id as string,
      url: req.url,
      method: req.method,
      phase: 'RESPONSE_COMPLETED',
      details: {
        statusCode,
        contentType,
        userAgent: req.headers['user-agent'],
      },
    };
    appendDebugLog(entry);
  });
}
