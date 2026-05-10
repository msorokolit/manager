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
  // Default points at the webpack-built bundle. Run `npm run build` in
  // frontend/ first, or set STATIC_DIR to a different directory.
  staticDir:
    process.env.STATIC_DIR ||
    path.resolve(__dirname, '..', '..', 'frontend', 'dist'),
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
  jwtSecret: process.env.JWT_SECRET || null,
  jwtTtlSeconds: Math.max(
    60,
    parseInt(process.env.JWT_TTL_SECONDS || '43200', 10), // 12h default
  ),
  // Security headers
  helmetDisabled: bool('HELMET_DISABLED', false),
  cspDisabled: bool('CSP_DISABLED', false),
  // Extra CSP source allow-listings (comma-separated). Useful when an
  // operator forks the SPA and adds another CDN.
  cspExtraScriptSrc: (process.env.CSP_EXTRA_SCRIPT_SRC || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  cspExtraStyleSrc: (process.env.CSP_EXTRA_STYLE_SRC || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  cspExtraConnectSrc: (process.env.CSP_EXTRA_CONNECT_SRC || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});

export const VERSION = '0.1.0';
