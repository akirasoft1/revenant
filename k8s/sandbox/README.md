# Agentic Sandbox Manifests

These manifests support the Python agent sidecar and Kata-Containers-based
sandbox executions (see
`docs/superpowers/specs/2026-04-28-agentic-sandbox-skills-runtime-design.md`).

## Why Kata, not gVisor

The cluster runs on Harvester (immutable SLE Micro host OS, KubeVirt for VM
workloads). The original spec called for gVisor + `runsc`, but installing
runsc into `/usr/local/bin` on each Harvester worker node is fragile under
the transactional update model — the install either fails outright or gets
wiped on the next OS update.

Kata Containers replaces the syscall-interception isolation model with a
"pod-as-tiny-VM" model: each sandbox pod boots its own QEMU/KVM guest with a
fresh kernel. The host kernel never executes the workload's syscalls; the
guest kernel does. That's a stronger isolation boundary than gVisor's
ptrace-based filtering and it leans into what Harvester already does
extremely well — so this is, on balance, a better fit even setting the
install pain aside.

**Trade-offs:**
- Cold start per sandbox call: ~1.5–3 s vs gVisor's ~200–500 ms. Acceptable
  given Discord conversational latency, and called out to the agent in its
  prompt so it doesn't think a long call has hung.
- No syscall-deny telemetry. gVisor's `gvisor_events` field has been
  renamed to a runtime-neutral `runtime_events` (kept empty by default
  under Kata; reserved for future `auditd`-in-guest signals).
- Host-side memory overhead per pod is ~50–100 MiB higher (guest kernel +
  agent). Within our existing limits.

## Files

| File | Purpose |
|---|---|
| `runtimeclass-kata.yaml` | Cluster-wide `kata-qemu` RuntimeClass declaration. NOT applied (the Helm chart provides it); kept in-repo as documentation of the RuntimeClass shape we depend on. |
| `cloudinit-kata-disable-sev.yaml` | Harvester `CloudInit` CR that **durably** disables `kvm_amd` SEV advertisement across reboots (see Step 3). Required on AMD Harvester hosts; without it sandbox starts fail `SEV not supported` after any node reboot. |
| `agent-serviceaccount.yaml` | `agent-sa` SA used by the sidecar Deployment. |
| `agent-role.yaml` | `agent-sandbox-orchestrator` Role: create/get/list/delete Jobs, get/list/watch/create Pods + pods/log + pods/attach. |
| `agent-rolebinding.yaml` | Binds the role to `agent-sa`. |
| `sandbox-serviceaccount.yaml` | `sandbox-sa` SA for sandbox Pods (no SA token mount). |
| `sandbox-networkpolicy.yaml` | Egress: allow public internet, deny all RFC1918 + cluster pod/service CIDRs (10.52/16 and 10.53/16 — pinned to this Harvester cluster's RKE2 defaults). |
| `agent-networkpolicy.yaml` | Sidecar can reach kube-dns, in-cluster MongoDB and Qdrant, the K8s API server, and OpenAI's public API only. Ingress only from the bot pod. |
| `configmap-sandbox.yaml` | Sandbox tunables (concurrency caps, wall clock, resource limits, retention, agent toggle). |
| `agent-deployment.yaml` | Sidecar Deployment (Recreate strategy, single replica). Update the `:latest` tag to a git-sha after `Phase 9 / Task 9.1` builds the image. |
| `agent-service.yaml` | ClusterIP Service exposing the sidecar's gRPC port (50051). |

## Required modifications to existing manifests

The existing bot manifests need two small additions. Working copies live
locally in `k8s/overlays/deployed/` (gitignored); the diffs are reproduced
here for traceability.

### `deployment.yaml` (bot)

Inside the bot container's `envFrom` list, append a reference to the sandbox
ConfigMap so the bot reads `AGENT_ENABLED` and `AGENT_GRPC_ADDR`:

```yaml
          envFrom:
            - configMapRef:
                name: discord-article-bot-config
            - configMapRef:
                name: sandbox-config
                optional: true
```

### `networkpolicy.yaml` (bot)

Append an egress rule allowing the bot to reach the agent sidecar's gRPC port:

```yaml
    # Allow bot -> agent sidecar gRPC
    - to:
        - podSelector:
            matchLabels:
              app: discord-article-bot-agent
      ports:
        - protocol: TCP
          port: 50051
```

## Prereq: install Kata on the cluster

The install has more moving parts than the upstream "one-helm-install" docs
suggest, because Harvester's host OS (SLE Micro) is immutable and ships an
older glibc than upstream Kata's binaries are built against. We hit four
distinct issues during the first install on this cluster — all are recorded
below so a future install (here, on another Harvester cluster, or after a
Kata version bump) doesn't have to rediscover them.

### Step 1 — install the Helm chart

The upstream `kata-deploy` Helm chart is published as an OCI artifact at
`oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy`. It deploys
a DaemonSet that drops Kata's binaries into `/opt/kata/` on each node, sets
up containerd drop-in config, and creates the standard Kata RuntimeClasses
(`kata`, `kata-qemu`, `kata-qemu-runtime-rs`, `kata-clh`, `kata-fc`, …).

```bash
export KATA_VERSION=$(curl -sSL https://api.github.com/repos/kata-containers/kata-containers/releases/latest | jq -r .tag_name)
export KATA_CHART="oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy"

helm install kata-deploy "$KATA_CHART" --version "$KATA_VERSION" \
  -n kube-system \
  --set k8sDistribution=rke2

kubectl rollout status -n kube-system ds/kata-deploy --timeout=600s
```

The `k8sDistribution=rke2` value is required — the chart's default
(`k8sDistribution: k8s`) sets `CONTAINERD_CONF_FILE` to `/etc/containerd/config.toml`
which doesn't exist as a single rendered file on RKE2.

### Step 2 — patch RKE2's containerd template on every node

After the chart installs, kata-deploy will refuse to finish with:

```
K3s/RKE2: rendered config at /etc/containerd/config.toml does not import
the drop-in dir 'config-v3.toml.d'
```

RKE2 renders its containerd config from a Go template. By default the
template doesn't include an `imports = [...]` directive, so kata-deploy's
drop-in files (which it writes into `config-v3.toml.d/`) are never picked
up. The fix is one file per node, persisted across reboots because
`/var/lib/rancher/rke2/` is on the writable `/var` overlay:

1. Copy `/var/lib/rancher/rke2/agent/etc/containerd/config.toml` to
   `/var/lib/rancher/rke2/agent/etc/containerd/config.toml.tmpl` (note the
   **tmpl** extension, not `tpl`).
2. Add this single line at the very top of the template:
   ```toml
   imports = ["/var/lib/rancher/rke2/agent/etc/containerd/config-v3.toml.d/*.toml"]
   ```
3. Restart RKE2 to re-render: `systemctl start rke2-server` (control plane)
   or `systemctl start rke2-agent` (workers). Use `start`, not `restart` —
   on busy nodes the stop step can exceed `TimeoutStopSec` and leave the
   unit `failed`. If that happens, `systemctl reset-failed rke2-server`
   then `systemctl start rke2-server`. The 810-task `containerd-shim`
   processes "remaining running after unit stopped" are workload pods —
   they survive the bounce intentionally; do not kill them.
4. Verify: `sudo grep -i imports /var/lib/rancher/rke2/agent/etc/containerd/config.toml`
   should show the `imports = [...]` line in the rendered config.

### Step 3 — disable kvm_amd's SEV advertisement (AMD hosts only)

Kata's runtime-rs probes for AMD SEV memory encryption support on every
sandbox start. The kvm_amd kernel module advertises SEV as available
(`/sys/module/kvm_amd/parameters/sev` reports `Y`) whenever the CPU is
SEV-capable, regardless of whether SEV is actually enabled in BIOS. When
the runtime then runs `cpuid(0x8000_001f)` to read SEV's runtime state,
the bit reports unavailable → `Failed to check guest protection: SEV not
supported` and the sandbox start aborts. This is a runtime-rs fail-closed
bug; we don't want SEV anyway.

> **⚠️ This must be persisted via Harvester's `CloudInit` CRD, NOT by
> writing the file directly to the host.** Harvester's host OS is immutable:
> the runtime `/etc` overlay (and `/oem`, which is read-only at runtime) is
> **reset from the OS image on every reboot**. A hand-written
> `/etc/modprobe.d/kata-disable-sev.conf` therefore silently vanishes on the
> next reboot and every sandbox start breaks again with `SEV not supported`.
> This bit us on 2026-06-17: all three nodes had rebooted ~4.4 days earlier,
> the file was gone on all of them, and `sev` was back to `Y`.

#### Durable fix — the `CloudInit` CRD (do this)

`harvester-node-manager` watches the cluster-scoped
`cloudinits.node.harvesterhci.io` CRD and writes each entry into `/oem/`
(the one persistent host location), where Elemental/yip re-applies it on
every boot. Apply the in-repo manifest:

```bash
kubectl apply -f k8s/sandbox/cloudinit-kata-disable-sev.yaml
```

It writes `/etc/modprobe.d/kata-disable-sev.conf` in the `initramfs` yip
stage (before `kvm_amd` loads) and, belt-and-suspenders, runs a `boot`-stage
command that reloads `kvm_amd` if it somehow came up with `sev=Y` while idle
(`refcnt==0`). It targets all Harvester-managed nodes via
`matchSelector: { harvesterhci.io/managed: "true" }`. Reboot a node and
confirm `cat /sys/module/kvm_amd/parameters/sev` still reports `N` to prove
persistence.

#### Manual immediate recovery (runbook)

If a node reboots before the CloudInit fix is in place — or you need to
recover *right now* — repeat the ephemeral write + live reload on each
affected node. This is only a stopgap: it does NOT survive the next reboot.
The live reload is safe only when `kvm_amd` is idle (`refcnt==0`, i.e. no
running VM/Kata guest on that node); otherwise the unload fails harmlessly
and you should drain + reboot the node instead.

```bash
for n in $(kubectl get nodes -o name); do
  echo "== $n =="
  kubectl debug "$n" --image=busybox --profile=sysadmin -q -- sh -c '
    printf "options kvm_amd sev=0 sev_es=0 sev_snp=0\n" > /host/etc/modprobe.d/kata-disable-sev.conf
    [ "$(cat /host/sys/module/kvm_amd/refcnt)" = "0" ] \
      && chroot /host modprobe -r kvm_amd && chroot /host modprobe kvm_amd
    echo -n "sev="; cat /host/sys/module/kvm_amd/parameters/sev'   # want: N
done
# (kubectl debug streaming is flaky; if you see no output, read the pod log:
#  kubectl logs -n default $(kubectl get po -n default -o name | grep node-debugger | tail -1) )
```

Disabling SEV is reversible (delete the CloudInit / file, reload the module)
and does NOT disable any KubeVirt functionality on Harvester — only the
SEV/SEV-SNP encrypted-memory features, which we aren't using and which
weren't even enabled in BIOS.

### Step 4 — pick the right RuntimeClass

Two viable RuntimeClasses exist after install:

- `kata-qemu` — Kata's Go runtime. Dynamically linked against glibc 2.34+
  on recent Kata releases. SLE Micro 5.x ships glibc 2.31 → fails to load
  with `version 'GLIBC_2.34' not found`.
- `kata-qemu-runtime-rs` — Kata's Rust rewrite. Statically linked
  (`objdump -T` shows no dynamic symbol table → no glibc dependency at
  all). Works on any host kernel + libc combination.

**We use `kata-qemu-runtime-rs`** (already wired into `job_template.py`).
runtime-rs is also where Kata's active development is happening, so this
isn't a workaround — it's the modern path.

### Step 5 — opt sandbox pods out of Dynatrace OneAgent injection

The cluster runs Dynatrace OneAgent in cloud-native fullstack mode. Its
mutating webhook injects an init container + an `LD_PRELOAD`-based agent
into every new pod's main container. Inside a Kata guest VM the OneAgent
spawns helper processes that prevent PID 1 from exiting cleanly when the
user's code finishes — the pod runs the workload in 5 seconds, then sits
idle for ~120 seconds until kubelet's grace timeout fires. That's not
acceptable for ephemeral sandbox pods (concurrency caps + wall-clock
balloons).

The Dynatrace operator honors a master-switch annotation defined in
`pkg/webhook/mutation/pod/mutator/config.go`:

```go
// AnnotationDynatraceInject is set to "false" on the Pod to indicate that does not want any injection.
AnnotationDynatraceInject = "dynatrace.com/inject"
```

`job_template.py` sets `dynatrace.com/inject: "false"` on every sandbox
pod, which short-circuits the webhook before any of its mutators run.
The bot + agent sidecar (where Dynatrace observability does pay off) are
not affected.

### Smoke test

After steps 1–5 are done on every node, run this to confirm everything's
wired up correctly:

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: kata-smoke
  annotations:
    dynatrace.com/inject: "false"
spec:
  runtimeClassName: kata-qemu-runtime-rs
  restartPolicy: Never
  containers:
    - name: kata-smoke
      image: busybox
      command: ["sh", "-c", "uname -a; echo ---; cat /proc/cpuinfo | head -3; sleep 5"]
EOF

sleep 15
kubectl get pod kata-smoke
kubectl logs kata-smoke
```

Expected: `STATUS: Completed`, no init containers, and `uname -a` reporting
a kernel version that is **not** the Harvester host's kernel — that's the
visual confirmation the workload ran inside a Kata-managed VM.

## Apply order (after kata-deploy is healthy)

```bash
# All resources are namespace-scoped; the Helm chart already created the
# RuntimeClass so we don't need to apply runtimeclass-kata.yaml here.
kubectl apply -n discord-article-bot \
  -f agent-serviceaccount.yaml \
  -f sandbox-serviceaccount.yaml \
  -f agent-role.yaml \
  -f agent-rolebinding.yaml \
  -f configmap-sandbox.yaml \
  -f agent-networkpolicy.yaml \
  -f sandbox-networkpolicy.yaml \
  -f agent-deployment.yaml \
  -f agent-service.yaml
```

## Pre-apply checklist

- [ ] `helm list -n kube-system` shows `kata-deploy` deployed; the DaemonSet is healthy on every worker node
- [ ] On every RKE2 node, `/var/lib/rancher/rke2/agent/etc/containerd/config.toml.tmpl` exists and has the `imports = [...]` line at the top, AND the rendered `config.toml` contains the same line
- [ ] `kubectl get cloudinit kata-disable-sev` exists (the durable SEV fix, applied from `cloudinit-kata-disable-sev.yaml`); on every AMD node `/etc/modprobe.d/kata-disable-sev.conf` is present and `cat /sys/module/kvm_amd/parameters/sev` returns `N`. **Do not rely on a hand-written file — it does not survive reboots on Harvester.**
- [ ] Kata smoke-test pod (see "Smoke test" above) reaches `Completed` status
- [ ] `sandbox-networkpolicy.yaml`'s pod/service CIDRs match this cluster (default: 10.52.0.0/16 and 10.53.0.0/16)
- [ ] `mvilliger/discord-article-bot-agent:<TAG>` and `mvilliger/sandbox-base:<TAG>` pushed (Task 9.1)
- [ ] Bot deployment + bot networkpolicy updates merged (see above)
