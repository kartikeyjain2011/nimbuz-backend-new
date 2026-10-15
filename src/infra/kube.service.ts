import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent } from 'undici';

export type Meta = { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; resourceVersion?: string; creationTimestamp?: string };
export type VirtualMachine = {
  metadata: Meta;
  spec: { runStrategy?: string; running?: boolean; instancetype?: { name: string; kind?: string }; template?: unknown; dataVolumeTemplates?: unknown[] };
  status?: { printableStatus?: string; ready?: boolean };
};
export type VirtualMachineInstance = {
  metadata: Meta;
  status?: { phase?: string; interfaces?: { ipAddress?: string; name?: string }[]; nodeName?: string };
};

/**
 * Thin Kubernetes REST client for KubeVirt + CDI, authenticated with a ServiceAccount token.
 * See deploy/k8s for the namespace, RBAC and pool templates.
 */
@Injectable()
export class KubeService {
  private readonly log = new Logger(KubeService.name);
  private readonly dispatcher?: Agent;
  readonly namespace: string;

  constructor(private readonly config: ConfigService) {
    this.namespace = config.get('K8S_NAMESPACE') ?? 'nimbus';
    const ca = config.get<string>('K8S_CA_B64');
    const insecure = config.get('K8S_INSECURE_SKIP_TLS') === 'true';
    if (ca || insecure) this.dispatcher = new Agent({ connect: ca ? { ca: Buffer.from(ca, 'base64').toString('utf8') } : { rejectUnauthorized: false } });
  }

  get enabled() {
    return Boolean(this.config.get('K8S_API_URL') && this.config.get('K8S_TOKEN'));
  }

  async request<T>(path: string, init: { method?: string; body?: unknown; contentType?: string } = {}): Promise<T> {
    if (!this.enabled) throw new ServiceUnavailableException('Cluster not configured (K8S_API_URL / K8S_TOKEN)');
    const res = await fetch(`${this.config.get('K8S_API_URL')}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.config.get('K8S_TOKEN')}`,
        Accept: 'application/json',
        ...(init.body !== undefined && { 'Content-Type': init.contentType ?? 'application/json' }),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      // @ts-expect-error undici dispatcher is supported by Node's fetch
      dispatcher: this.dispatcher,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log.warn(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
      const err = new Error(`Kubernetes ${res.status}: ${text.slice(0, 200)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private vmPath = (name = '') => `/apis/kubevirt.io/v1/namespaces/${this.namespace}/virtualmachines${name && `/${name}`}`;

  listVMs(selector: string) {
    return this.request<{ items: VirtualMachine[] }>(`${this.vmPath()}?labelSelector=${encodeURIComponent(selector)}`).then((r) => r.items);
  }

  getVM = (name: string) => this.request<VirtualMachine>(this.vmPath(name));
  createVM = (vm: VirtualMachine) => this.request<VirtualMachine>(this.vmPath(), { method: 'POST', body: vm });
  deleteVM = (name: string) => this.request(this.vmPath(name), { method: 'DELETE' });

  /** JSON merge-patch with optimistic concurrency (fails with 409 if someone else changed it). */
  patchVM(name: string, patch: unknown) {
    return this.request<VirtualMachine>(this.vmPath(name), { method: 'PATCH', body: patch, contentType: 'application/merge-patch+json' });
  }

  start = (name: string) => this.request(`/apis/subresources.kubevirt.io/v1/namespaces/${this.namespace}/virtualmachines/${name}/start`, { method: 'PUT', body: {} });
  stop = (name: string) => this.request(`/apis/subresources.kubevirt.io/v1/namespaces/${this.namespace}/virtualmachines/${name}/stop`, { method: 'PUT', body: {} });

  getVMI(name: string) {
    return this.request<VirtualMachineInstance>(`/apis/kubevirt.io/v1/namespaces/${this.namespace}/virtualmachineinstances/${name}`).catch((e: { status?: number }) => {
      if (e.status === 404) return null;
      throw e;
    });
  }

  /** Cluster-wide view for the admin dashboard. */
  nodes() {
    return this.request<{ items: { metadata: Meta; status: { allocatable?: Record<string, string>; capacity?: Record<string, string> } }[] }>('/api/v1/nodes').then((r) => r.items);
  }
}
