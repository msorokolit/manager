// Lazy singleton wrapper around dockerode.
import Docker from 'dockerode';
import { settings } from './config.js';

let client = null;

function build() {
  if (!settings.dockerHost) return new Docker(); // /var/run/docker.sock
  // Accept either tcp://host:port, unix:///path, or just /path
  const raw = settings.dockerHost;
  if (raw.startsWith('/')) return new Docker({ socketPath: raw });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid DOCKER_HOST: ${raw}`);
  }
  if (url.protocol === 'unix:') return new Docker({ socketPath: url.pathname });
  if (url.protocol === 'tcp:' || url.protocol === 'http:') {
    return new Docker({
      host: url.hostname,
      port: url.port ? Number(url.port) : 2375,
      protocol: 'http',
    });
  }
  if (url.protocol === 'https:') {
    return new Docker({
      host: url.hostname,
      port: url.port ? Number(url.port) : 2376,
      protocol: 'https',
    });
  }
  throw new Error(`Unsupported DOCKER_HOST protocol: ${url.protocol}`);
}

export function getClient() {
  if (client) return client;
  client = build();
  return client;
}

/**
 * Map an error from dockerode (or a connection error) onto a HTTP-friendly
 * shape so route handlers can throw uniformly.
 */
export function dockerError(err) {
  if (!err) return { status: 500, detail: 'Unknown error' };
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
    return {
      status: 503,
      detail: `Cannot connect to Docker daemon: ${err.message}`,
    };
  }
  const msg = (err.json && err.json.message) || err.reason || err.message;
  if (err.statusCode === 404) return { status: 404, detail: msg || 'Not found' };
  if (err.statusCode === 409) return { status: 409, detail: msg || 'Conflict' };
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return { status: err.statusCode, detail: msg };
  }
  return { status: 502, detail: msg || 'Docker daemon error' };
}
