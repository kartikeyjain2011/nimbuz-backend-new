import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanId } from '@prisma/client';
import { PLAN_ORDER, tier as tierIndex } from '../common/plans';
import { KubeService, type VirtualMachine } from './kube.service';

export const LABEL = {
  pool: 'nimbus.io/pool',
  region: 'nimbus.io/region',
  tier: 'nimbus.io/tier',
} as const;

export const ANN = {
  lease: 'nimbus.io/lease',
  user: 'nimbus.io/lease-user',
  at: 'nimbus.io/leased-at',
} as const;

/** { "mumbai": { "basic": 4, "pro": 2, "premium": 1, "ultimate": 1 } } */
type PoolConfig = Record<string, Partial<Record<PlanId, number>>>;

export type LeasedVm = { name: string; ip: string; publicIp?: string; node?: string; tier: PlanId };

/** Set on each VM once: the public IP its agent is reachable on (KubeVirt only reports the pod IP). */
export const PUBLIC_IP_ANNOTATION = 'nimbus.io/public-ip';

const BOOT_TIMEOUT_MS = 3 * 60_000;
const STALE_LEASE_MS = 12 * 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class VmPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(VmPoolService.name);
  private timer?: NodeJS.Timeout;
  private reconciling = false;

  constructor(
    private readonly kube: KubeService,
    private readonly config: ConfigService,
  ) {}

  /** True when the backend is connected to the cluster (otherwise sessions are simulated). */
  get enabled() {
    return this.kube.enabled;
  }

  private get pool(): PoolConfig {
    try {
      return JSON.parse(this.config.get('VM_POOL') ?? '{}');
    } catch {
      return {};
    }
  }

  onModuleInit() {
    if (!this.kube.enabled) {
      this.log.warn('K8S_API_URL / K8S_TOKEN not set — sessions run without real VMs');
      return;
    }
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Lease a stopped VM in the region whose tier ≥ the plan (exact tier first), boot it, wait for an IP. */
  async acquire(region: string, plan: PlanId, sessionId: string, userId: string): Promise<LeasedVm> {
    const vms = await this.kube.listVMs(`${LABEL.pool}=gaming,${LABEL.region}=${region}`);
    const candidates = vms
      .filter((vm) => !this.protectedVms.has(vm.metadata.name) && !vm.metadata.annotations?.[ANN.lease] && (vm.status?.printableStatus ?? 'Stopped') === 'Stopped')
      .map((vm) => ({ vm, t: vm.metadata.labels?.[LABEL.tier] as PlanId }))
      .filter(({ t }) => t && tierIndex(t) >= tierIndex(plan))
      .sort((a, b) => tierIndex(a.t) - tierIndex(b.t));

    for (const { vm, t } of candidates) {
      try {
        await this.kube.patchVM(vm.metadata.name, {
          metadata: { resourceVersion: vm.metadata.resourceVersion, annotations: { [ANN.lease]: sessionId, [ANN.user]: userId, [ANN.at]: new Date().toISOString() } },
        });
      } catch (e) {
        if ((e as { status?: number }).status === 409) continue; // someone else grabbed it
        throw e;
      }

      try {
        await this.kube.start(vm.metadata.name);
        const booted = await this.waitForIp(vm.metadata.name);
        void this.reconcile();
        return { name: vm.metadata.name, tier: t, publicIp: vm.metadata.annotations?.[PUBLIC_IP_ANNOTATION], ...booted };
      } catch (e) {
        this.log.error(`VM ${vm.metadata.name} failed to boot: ${(e as Error).message}`);
        await this.release(vm.metadata.name).catch(() => {});
      }
    }
    throw new ServiceUnavailableException({ code: 'NO_CAPACITY', message: `No free ${plan}+ rigs in ${region} right now` });
  }

  private async waitForIp(name: string) {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const vmi = await this.kube.getVMI(name);
      const ip = vmi?.status?.interfaces?.find((i) => i.ipAddress)?.ipAddress;
      if (vmi?.status?.phase === 'Running' && ip) return { ip: ip.split('/')[0], node: vmi.status.nodeName };
      if (vmi?.status?.phase === 'Failed') throw new Error('VMI failed');
      await sleep(3000);
    }
    throw new Error('Timed out waiting for VM to boot');
  }

  /** Stop the VM and return it to the pool. */
  async release(name: string) {
    await this.kube.stop(name).catch((e: { status?: number }) => {
      if (e.status !== 409) throw e; // already stopped
    });
    await this.kube.patchVM(name, { metadata: { annotations: { [ANN.lease]: null, [ANN.user]: null, [ANN.at]: null } } });
  }

  /** Free/total VMs per region and tier, for capacity display and queue ETAs. */
  async capacity() {
    if (!this.kube.enabled) return null;
    const vms = await this.kube.listVMs(`${LABEL.pool}=gaming`);
    const out: Record<string, Record<string, { total: number; free: number; running: number }>> = {};
    for (const vm of vms) {
      const r = vm.metadata.labels?.[LABEL.region] ?? 'unknown';
      const t = vm.metadata.labels?.[LABEL.tier] ?? 'unknown';
      const cell = ((out[r] ??= {})[t] ??= { total: 0, free: 0, running: 0 });
      cell.total++;
      if (!vm.metadata.annotations?.[ANN.lease] && vm.status?.printableStatus === 'Stopped') cell.free++;
      if (vm.status?.printableStatus === 'Running') cell.running++;
    }
    return out;
  }

  /** Free rigs that can serve a plan in a region (tier ≥ plan). */
  async freeFor(region: string, plan: PlanId) {
    const cap = await this.capacity();
    if (!cap) return null;
    return PLAN_ORDER.filter((t) => tierIndex(t) >= tierIndex(plan)).reduce((n, t) => n + (cap[region]?.[t]?.free ?? 0), 0);
  }

  /** Keep the pool at the configured size, and recover leases that were never released. */
  async reconcile() {
    if (this.reconciling || !this.kube.enabled) return;
    this.reconciling = true;
    try {
      const vms = await this.kube.listVMs(`${LABEL.pool}=gaming`);

      for (const vm of vms) {
        const at = vm.metadata.annotations?.[ANN.at];
        if (at && Date.now() - Date.parse(at) > STALE_LEASE_MS) {
          this.log.warn(`Reclaiming stale lease on ${vm.metadata.name}`);
          await this.release(vm.metadata.name).catch(() => {});
        }
      }

      // Default "adopt" mode: the pool is your existing VMs (NVMesh disks with games installed) — never create any.
      if (this.config.get('VM_CREATE_MODE') !== 'clone') return;
      if (!this.config.get('GOLDEN_IMAGE_PVC') && !this.config.get('SOURCE_DISK_PVC')) {
        this.log.warn('VM_CREATE_MODE=clone but no GOLDEN_IMAGE_PVC / SOURCE_DISK_PVC set — not creating VMs');
        return;
      }

      for (const [region, tiers] of Object.entries(this.pool)) {
        for (const [t, want] of Object.entries(tiers) as [PlanId, number][]) {
          const have = vms.filter((vm) => vm.metadata.labels?.[LABEL.region] === region && vm.metadata.labels?.[LABEL.tier] === t).length;
          for (let i = have; i < want; i++) {
            const vm = this.template(region, t);
            this.log.log(`Creating pool VM ${vm.metadata.name}`);
            await this.kube.createVM(vm).catch((e) => this.log.error(`create failed: ${(e as Error).message}`));
          }
        }
      }
    } catch (e) {
      this.log.error(`reconcile failed: ${(e as Error).message}`);
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Add an existing VM (created in kubevirt-manager, NVMesh disks with games installed) to the pool
   * by labelling it. Its disks are left untouched.
   */
  async adopt(name: string, region: string, tier: PlanId, publicIp?: string) {
    if (this.protectedVms.has(name)) throw new ServiceUnavailableException(`${name} is protected (POOL_PROTECTED_VMS) and can't join the pool`);
    await this.kube.patchVM(name, {
      metadata: {
        labels: { [LABEL.pool]: 'gaming', [LABEL.region]: region, [LABEL.tier]: tier },
        ...(publicIp && { annotations: { [PUBLIC_IP_ANNOTATION]: publicIp } }),
      },
    });
    return this.kube.getVM(name);
  }

  /** Remove a VM from the pool (labels only; the VM and its NVMesh volumes stay). */
  async unadopt(name: string) {
    await this.kube.patchVM(name, { metadata: { labels: { [LABEL.pool]: null, [LABEL.region]: null, [LABEL.tier]: null } } });
  }

  /** VMs the pool must never touch (the golden/build VM that owns the RWO game library). */
  get protectedVms() {
    return new Set((this.config.get<string>('POOL_PROTECTED_VMS') ?? 'golden-windows-build').split(',').map((s) => s.trim()).filter(Boolean));
  }

  /**
   * Only used with VM_CREATE_MODE=clone. Boot disk = CDI clone of GOLDEN_IMAGE_PVC on NVMesh.
   * Game library (np-game-library is Block + RWO, so it can't be shared as-is):
   *   GAME_LIBRARY_MODE=clone  → each VM gets its own NVMesh clone of GAME_LIBRARY_PVC (from GAME_LIBRARY_NAMESPACE)
   *   GAME_LIBRARY_MODE=shared → GAME_LIBRARY_PVC is an RWX/ROX copy in the VM namespace, attached read-only to every VM
   *   GAME_LIBRARY_MODE=none   → games live on the boot disk
   * The games disk keeps serial NIMBUSGAME so Windows maps it to the same drive letter as on the golden VM.
   */
  private template(region: string, tier: PlanId): VirtualMachine {
    const name = `nimbus-${region}-${tier}-${Math.random().toString(36).slice(2, 8)}`;
    const ns = this.kube.namespace;
    const bootClass = this.config.get('K8S_STORAGE_CLASS') ?? 'nvmesh-raid10';
    const source = this.config.get<string>('GOLDEN_IMAGE_PVC') || this.config.getOrThrow<string>('SOURCE_DISK_PVC');
    const bootSize = this.config.get('BOOT_DISK_SIZE') ?? '500Gi';

    const libMode = (this.config.get<string>('GAME_LIBRARY_MODE') ?? 'none') as 'clone' | 'shared' | 'none';
    const library = this.config.get<string>('GAME_LIBRARY_PVC');
    const libNs = this.config.get<string>('GAME_LIBRARY_NAMESPACE') ?? ns;
    const libClass = this.config.get<string>('GAME_LIBRARY_STORAGE_CLASS') ?? 'nvmesh-golden-retain';
    const libSize = this.config.get<string>('GAME_LIBRARY_SIZE') ?? '7451Gi';
    const libSerial = this.config.get<string>('GAME_LIBRARY_SERIAL') ?? 'NIMBUSGAME';
    const withLib = libMode !== 'none' && !!library;

    let nodeSelector: Record<string, string> | undefined;
    try {
      const raw = this.config.get<string>('VM_NODE_SELECTOR');
      nodeSelector = raw ? (JSON.parse(raw.replace('{region}', region)) as Record<string, string>) : undefined;
    } catch {
      nodeSelector = undefined;
    }

    const dataVolumeTemplates: unknown[] = [
      {
        metadata: { name: `${name}-boot` },
        spec: {
          source: { pvc: { namespace: ns, name: source } },
          storage: { storageClassName: bootClass, accessModes: ['ReadWriteOnce'], resources: { requests: { storage: bootSize } } },
        },
      },
    ];
    if (withLib && libMode === 'clone') {
      dataVolumeTemplates.push({
        metadata: { name: `${name}-games` },
        spec: {
          source: { pvc: { namespace: libNs, name: library } },
          storage: { storageClassName: libClass, accessModes: ['ReadWriteOnce'], volumeMode: 'Block', resources: { requests: { storage: libSize } } },
        },
      });
    }

    const gamesVolume =
      libMode === 'clone' ? { name: 'games', dataVolume: { name: `${name}-games` } } : { name: 'games', persistentVolumeClaim: { claimName: library!, readOnly: true } };

    return {
      metadata: { name, labels: { [LABEL.pool]: 'gaming', [LABEL.region]: region, [LABEL.tier]: tier } },
      spec: {
        runStrategy: 'Halted',
        instancetype: { kind: 'VirtualMachineClusterInstancetype', name: `nimbus-${tier}` },
        dataVolumeTemplates,
        template: {
          metadata: { labels: { [LABEL.pool]: 'gaming', [LABEL.region]: region, [LABEL.tier]: tier } },
          spec: {
            ...(nodeSelector && { nodeSelector }),
            domain: {
              devices: {
                disks: [
                  { name: 'boot', bootOrder: 1, disk: { bus: 'virtio' } },
                  ...(withLib ? [{ name: 'games', serial: libSerial, disk: { bus: 'virtio', ...(libMode === 'shared' && { readonly: true }) } }] : []),
                ],
                interfaces: [{ name: 'default', masquerade: {} }],
              },
            },
            networks: [{ name: 'default', pod: {} }],
            volumes: [{ name: 'boot', dataVolume: { name: `${name}-boot` } }, ...(withLib ? [gamesVolume] : [])],
          },
        },
      },
    };
  }
}
