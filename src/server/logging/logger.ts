import pino from 'pino';
import process from 'node:process';
import { loadConfig } from '../config/index';

// Environment variable set by TUI mode — suppress all info/debug/warn logs
// when running in interactive terminal UI.
const IS_TUI_MODE = Boolean(process.env.LATEDEV_TUI_MODE);

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger) return _logger;
  const cfg = loadConfig();

  // In TUI mode, use error-only level to keep console clean
  const effectiveLogLevel = IS_TUI_MODE ? 'error' : cfg.logLevel;

  _logger = pino({
    level: effectiveLogLevel,
    base: { app: 'latedev-router', version: cfg.appVersion },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'apiKey',
        'apiKeyPlain',
        'provider.apiKey',
        'provider.encrypted_api_key',
        'masterKey',
        'totpSecret',
        'recoveryCodes',
        'password',
        'currentPassword',
        'newPassword',
      ],
      censor: '[redacted]',
    },
    transport:
      cfg.env === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
        : undefined,
  });
  return _logger;
}

export type Logger = pino.Logger;
