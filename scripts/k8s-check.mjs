// Connectivity check: TLS with K8S_CA_B64, then (if K8S_TOKEN is set) list VMs in K8S_NAMESPACE.
//   node scripts/k8s-check.mjs
import 'dotenv/config';
import { Agent, fetch } from 'undici';

const { K8S_API_URL, K8S_TOKEN, K8S_CA_B64, K8S_NAMESPACE = 'nimbus' } = process.env;
const dispatcher = new Agent({ connect: { ca: Buffer.from(K8S_CA_B64 ?? '', 'base64').toString('utf8') } });
const get = (path) =>
  fetch(`${K8S_API_URL}${path}`, { dispatcher, headers: K8S_TOKEN ? { Authorization: `Bearer ${K8S_TOKEN}` } : {} }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => ({})),
  }));

try {
  const v = await get('/version');
  console.log('TLS ok · /version →', v.status, v.body.gitVersion ?? v.body.message ?? '');
} catch (e) {
  console.log('Connection failed:', e.cause?.code ?? e.message);
  process.exit(1);
}

if (!K8S_TOKEN) {
  console.log('K8S_TOKEN empty — skipping authenticated checks');
  process.exit(0);
}

const vms = await get(`/apis/kubevirt.io/v1/namespaces/${K8S_NAMESPACE}/virtualmachines`);
console.log(`VMs in ${K8S_NAMESPACE} →`, vms.status, vms.status === 200 ? vms.body.items.map((v) => `${v.metadata.name} (${v.status?.printableStatus})`) : vms.body.message);
const nodes = await get('/api/v1/nodes');
console.log('nodes →', nodes.status, nodes.status === 200 ? `${nodes.body.items.length} nodes` : nodes.body.message);
