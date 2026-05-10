// Runtime configuration loaded from environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

const dataDir = process.env.DATA_DIR || '/data';

export const settings = Object.freeze({
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  viewerUser: process.env.VIEWER_USER || null,
  viewerPassword: process.env.VIEWER_PASSWORD || null,
  dockerHost: process.env.DOCKER_HOST || null,
  allowDestructive: bool('ALLOW_DESTRUCTIVE', true),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  staticDir:
    process.env.STATIC_DIR || path.resolve(__dirname, '..', '..', 'frontend'),
  logTailDefault: parseInt(process.env.LOG_TAIL_DEFAULT || '200', 10),
  dataDir,
  stacksDir: process.env.STACKS_DIR || path.join(dataDir, 'stacks'),
  composeBin: process.env.COMPOSE_BIN || 'docker-compose',
  execDefaultShell: process.env.EXEC_DEFAULT_SHELL || '/bin/sh',
  registriesFile:
    process.env.REGISTRIES_FILE || path.join(dataDir, 'registries.json'),
  browserImage: process.env.BROWSER_IMAGE || 'python:3-alpine',
  port: parseInt(process.env.PORT || '8000', 10),
  host: process.env.HOST || '0.0.0.0',
});

export const VERSION = '0.1.0';
