import pino from 'pino';
import { loadConfig } from '../config/index';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger) return _logger;
  const cfg = loadConfig();
  _logger = pino({
    level: cfg.logLevel,
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
