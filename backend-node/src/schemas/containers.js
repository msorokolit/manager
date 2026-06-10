import { Type } from '@sinclair/typebox';
import { Opt, StringEnum } from './_common.js';

// Memory size string accepted by docker-cli: optional decimal followed by an
// optional k/m/g/t suffix, optional trailing 'b'. Examples: "512m", "1.5g",
// "0", "256". Bare integers are also fine. Schema accepts the string form OR
// a non-negative integer (interpreted as bytes by the daemon).
const MEM_SIZE_PATTERN = '^\\d+(?:\\.\\d+)?[kKmMgGtT]?[bB]?$';
const MemSize = Type.Union([
  Type.String({ pattern: MEM_SIZE_PATTERN }),
  Type.Integer({ minimum: 0 }),
]);
// `memswap_limit` additionally accepts -1 ("disable swap").
const MemSizeOrUnlimited = Type.Union([
  Type.String({ pattern: MEM_SIZE_PATTERN }),
  Type.Integer({ minimum: -1 }),
]);

const Ulimit = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    soft: Opt(Type.Integer()),
    hard: Opt(Type.Integer()),
  },
  { $id: 'Ulimit', additionalProperties: false },
);

const Healthcheck = Type.Object(
  {
    test: Opt(Type.Union([Type.Array(Type.String()), Type.String()])),
    interval: Opt(Type.Integer({ minimum: 0, description: 'Nanoseconds' })),
    timeout: Opt(Type.Integer({ minimum: 0, description: 'Nanoseconds' })),
    retries: Opt(Type.Integer({ minimum: 0 })),
    start_period: Opt(Type.Integer({ minimum: 0, description: 'Nanoseconds' })),
  },
  { $id: 'Healthcheck', additionalProperties: false },
);

const VolumeSpec = Type.Object(
  {
    bind: Type.String({ minLength: 1 }),
    mode: Type.Optional(Type.String()),
  },
  { $id: 'VolumeSpec', additionalProperties: false },
);

export const RESTART_POLICIES = ['no', 'always', 'unless-stopped', 'on-failure'];

export const CreateContainerRequest = Type.Object(
  {
    image: Type.String({ minLength: 1, maxLength: 512, description: 'Image reference, e.g. nginx:alpine' }),
    name: Opt(Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$' })),
    command: Opt(Type.Union([Type.String(), Type.Array(Type.String())])),
    entrypoint: Opt(Type.Union([Type.String(), Type.Array(Type.String())])),
    env: Opt(Type.Record(Type.String(), Type.String())),
    ports: Opt(
      Type.Record(
        Type.String(),
        Type.Union([Type.Integer(), Type.String(), Type.Null()]),
        { description: 'Container port -> host port, e.g. {"80/tcp": 8080}' },
      ),
    ),
    volumes: Opt(Type.Record(Type.String(), VolumeSpec)),
    restart_policy: Opt(StringEnum(RESTART_POLICIES)),
    network: Opt(Type.String()),
    network_mode: Opt(Type.String()),
    labels: Opt(Type.Record(Type.String(), Type.String())),
    detach: Type.Optional(Type.Boolean({ default: true })),
    pull: Type.Optional(Type.Boolean({ default: false })),

    user: Opt(Type.String()),
    working_dir: Opt(Type.String()),
    hostname: Opt(Type.String({ maxLength: 253 })),
    domainname: Opt(Type.String({ maxLength: 253 })),
    init: Opt(Type.Boolean()),
    stop_signal: Opt(Type.String()),
    stop_grace_period: Opt(Type.Integer({ minimum: 0, description: 'Seconds' })),
    tty: Opt(Type.Boolean()),
    stdin_open: Opt(Type.Boolean()),
    auto_remove: Opt(Type.Boolean()),
    read_only: Opt(Type.Boolean()),

    dns: Opt(Type.Array(Type.String())),
    dns_search: Opt(Type.Array(Type.String())),
    dns_opt: Opt(Type.Array(Type.String())),
    extra_hosts: Opt(Type.Record(Type.String(), Type.String())),
    mac_address: Opt(Type.String()),

    tmpfs: Opt(Type.Record(Type.String(), Type.String())),

    cpus: Opt(Type.Number({ minimum: 0 })),
    cpu_shares: Opt(Type.Integer({ minimum: 0 })),
    cpuset_cpus: Opt(Type.String()),
    mem_limit: Opt(MemSize),
    mem_reservation: Opt(MemSize),
    memswap_limit: Opt(MemSizeOrUnlimited),
    pids_limit: Opt(Type.Integer()),
    shm_size: Opt(MemSize),
    ulimits: Opt(Type.Array(Ulimit)),
    devices: Opt(Type.Array(Type.String())),
    gpus: Opt(Type.Union([Type.Integer(), Type.String()])),

    privileged: Opt(Type.Boolean()),
    cap_add: Opt(Type.Array(Type.String())),
    cap_drop: Opt(Type.Array(Type.String())),
    security_opt: Opt(Type.Array(Type.String())),
    sysctls: Opt(Type.Record(Type.String(), Type.String())),

    healthcheck: Opt(Healthcheck),

    log_driver: Opt(Type.String()),
    log_opts: Opt(Type.Record(Type.String(), Type.String())),
  },
  { $id: 'CreateContainerRequest', additionalProperties: false },
);

export const ContainerSummary = Type.Object(
  {
    id: Type.String(),
    short_id: Type.String(),
    name: Type.String(),
    image: Opt(Type.String()),
    status: Opt(Type.String()),
    state: Opt(Type.String()),
    health: Opt(Type.String()),
    started_at: Opt(Type.String()),
    created: Opt(Type.String()),
    restart_policy: Opt(Type.String()),
    command: Opt(Type.Union([Type.String(), Type.Array(Type.String())])),
    labels: Type.Record(Type.String(), Type.String()),
    ports: Type.Record(
      Type.String(),
      Type.Array(
        Type.Object({
          HostIp: Type.String(),
          HostPort: Type.String(),
        }),
      ),
    ),
    networks: Type.Array(Type.String()),
  },
  { $id: 'ContainerSummary', additionalProperties: true },
);

// Inspect responses are passed through from dockerode unchanged; documenting
// every field is impractical, so we model it as an open object.
export const PassThroughObject = Type.Object({}, { additionalProperties: true });
