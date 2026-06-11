import { Type } from '@sinclair/typebox';
import { Opt, StringEnum } from './_common.js';

export const PingResponse = Type.Object(
  {
    ok: Type.Boolean(),
    user: Type.String(),
    role: StringEnum(['admin', 'viewer']),
  },
  { $id: 'PingResponse', additionalProperties: false },
);

export const HealthResponse = Type.Object(
  {
    status: Type.Literal('ok'),
    version: Type.String(),
  },
  { $id: 'HealthResponse', additionalProperties: false },
);

export const ConfigResponse = Type.Object(
  {
    version: Type.String(),
    allow_destructive: Type.Boolean(),
    compose_available: Type.Boolean(),
    stacks_dir: Type.String(),
    exec_default_shell: Type.String(),
    browser_image: Type.String(),
    registries_file: Type.String(),
    backend: Type.Literal('node'),
  },
  { $id: 'ConfigResponse', additionalProperties: true },
);

export const TicketResponse = Type.Object(
  {
    ticket: Type.String(),
    expires_in: Type.Integer({ minimum: 1 }),
  },
  { $id: 'TicketResponse', additionalProperties: false },
);

// ---------- Accelerator + device discovery ----------

/** One row in `docker info` Runtimes. `runc` ships with the daemon;
 *  `nvidia`, `crun`, `kata-runtime` etc. land via OCI runtime plugins. */
export const RuntimeInfo = Type.Object(
  {
    name: Type.String(),
    path: Opt(Type.String()),
    status: Opt(Type.Object({}, { additionalProperties: true })),
  },
  { $id: 'RuntimeInfo', additionalProperties: true },
);

/** One NVIDIA GPU as reported by `nvidia-smi`. Fields may be null
 *  when smi output is shorter than expected (older driver versions). */
export const NvidiaGpu = Type.Object(
  {
    index: Type.String({ description: 'GPU index (e.g. "0", "1")' }),
    uuid: Opt(Type.String()),
    name: Opt(Type.String()),
    memory_mb: Opt(Type.Integer()),
    driver_version: Opt(Type.String()),
  },
  { $id: 'NvidiaGpu', additionalProperties: false },
);

export const DeviceDiscoveryResponse = Type.Object(
  {
    runtimes: Type.Array(RuntimeInfo),
    default_runtime: Type.String(),
    gpu_runtime: Opt(Type.String({
      description: 'Suggested runtime for GPU workloads (typically "nvidia" when present, else null).',
    })),
    nvidia: Type.Object(
      {
        available: Type.Boolean(),
        note: Opt(Type.String({
          description: 'Why GPUs could not be enumerated (e.g. nvidia-smi absent, manager container can\'t see /dev/nvidia*).',
        })),
        gpus: Opt(Type.Array(NvidiaGpu)),
      },
      { additionalProperties: false },
    ),
    dri: Type.Object(
      {
        available: Type.Boolean(),
        note: Opt(Type.String()),
        devices: Opt(Type.Array(Type.String(), {
          description: 'Discovered /dev/dri/* device paths (Intel/AMD VAAPI).',
        })),
      },
      { additionalProperties: false },
    ),
    discovered_at: Type.String({ description: 'ISO timestamp; results are cached for 30s.' }),
  },
  { $id: 'DeviceDiscoveryResponse', additionalProperties: false },
);
