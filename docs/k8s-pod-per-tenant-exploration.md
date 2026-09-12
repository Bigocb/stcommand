# Exploration: pod-per-tenant on Kubernetes

Status: exploratory only, written for future reference. Nothing here is a
proposal to act on now, and nothing in the current architecture is changed by
this document. It exists because the idea was raised and deserves a real
answer instead of a gut reaction, not because anything about the current
setup is currently failing.

The question: replace the current single Render web service (`stcommand`,
`srv-da0veurl550s73eg2sog`, one process holding all tenants) with a
Kubernetes cluster running one pod per tenant, each pod holding one
tenant's `{api, store, state, fleet, chat?}` bundle
(`src/engine/tenantRegistry.ts:14-29`) instead of that bundle living as one
entry in an in-process `Map` (`tenantRegistry.ts:69`).

Short version up front, argued in full below: **the idea does not survive
contact with the one fact that actually governs this app's scaling —
SpaceTraders rate-limits by source IP, not by tenant.** Every version of
pod-per-tenant either reproduces the exact shared-budget problem the current
design already solves in-process (only worse, because you've traded a
priority queue for a distributed one you haven't built), or it requires
per-pod public egress IPs, which is a real infrastructure ask that changes
the cost story completely and that none of the three cheap providers in the
pricing research give you by default. Sections 2-4 go on to show that most of
what pod-per-tenant would buy is either already true today or gets *harder*,
not easier. Section 6 gives the recommendation.

---

## 1. The rate limiter: the question this whole idea turns on

### What's true today

`RateLimiter` (`src/core/client.ts:71-146`) is a priority-queued token
bucket. `TenantRegistry` constructs exactly one of them per process —
`new RateLimiter(1.5, Math.ceil(1.5))` at `tenantRegistry.ts:89` — and every
tenant's `Client` is built with `sharedLimiter: this.apiLimiter`
(`tenantRegistry.ts:98-104`). The reason is spelled out in both places
(`client.ts:28-42`, `tenantRegistry.ts:73-84`): **SpaceTraders enforces its
2 req/s cap per source IP, not per agent token.** A single Render instance
serving 3 tenants is, from SpaceTraders' point of view, one caller. If each
tenant's `Client` self-throttled independently at 1.5 req/s, three tenants
ticking at once would present as 4.5 req/s from one IP and get 429'd — this
was observed in production before the shared limiter existed
(`client.ts:203-207`, `rate-limiter-saturation-plan.md:1-14`).

`docs/control-plane-data-plane.md:307-311` names this directly as the one
place its own Kubernetes analogy for the app's *internal* architecture
breaks down: `SchedulerBudget` is "the one place the kubelet analogy
strains, since our nodes share one 2 req/s pipe." That line is about ships
inside one tenant sharing one process's budget. The same physics apply one
level up, and this document is about what happens when you take that
strained analogy and try to make it literal — real pods, on a real cluster,
each with its own process boundary.

### What pod-per-tenant actually has to answer

Splitting tenants into separate pods does not change what SpaceTraders sees.
It only changes *how many independent processes* are drawing from the same
real ceiling, and there are exactly two ways that can shake out:

**A. All pods share one cluster egress IP (the default on every cheap
managed K8s option).** Civo, Vultr, and DigitalOcean's basic node pools
route outbound traffic through the node itself or a shared NAT path — none
of the three cheap tiers in the pricing research provisions a distinct
public IP per pod by default. In this shape, N tenant pods are still N
processes sharing one real 2 req/s SpaceTraders ceiling, exactly as today —
except the coordination mechanism that currently holds that ceiling
(`RateLimiter`'s in-memory priority queue, one object, one event loop) no
longer exists, because it can't span pods. You would need to rebuild it as a
distributed rate limiter — a Redis-backed token bucket, most likely, with
its own network round trip on every single API call, its own failure mode
when Redis is slow or briefly unavailable, and its own version of the
starvation bug `RateLimiter`'s doc comment already describes fixing once
(`client.ts:86-105`: a new tenant's boot losing the race against established
tenants' ticking traffic, before priority-queueing fixed it). That bug was
found and fixed *because* the limiter is one object one team could reason
about. A Redis-based equivalent is a harder version of the same problem,
built to solve a scaling need that — at 3 tenants — doesn't exist yet. This
is not an isolation improvement. It's the identical shared-budget problem,
moved from an in-process data structure to a network service, for the same
result.

**B. Each pod gets its own real public egress IP.** This is the only shape
where pod-per-tenant actually *solves* the rate-limit problem — each tenant
would get a genuine, unshared 2 req/s from SpaceTraders' perspective, and
the whole shared-limiter mechanism (`RateLimiter`, `apiLimiter`,
`sharedLimiter`, the priority-queue starvation fix, the saturation-shedding
plan in `docs/rate-limiter-saturation-plan.md`) could be deleted outright —
each tenant's `Client` would go back to owning its own private limiter, the
`Client` default that already exists and already works
(`client.ts:20-49`'s `sharedLimiter` doc comment: omitted, a Client gets its
own). That's a real architectural win, not a wash.

But per-pod public IPs are not a checkbox on Civo/Vultr/DOKS's basic tiers.
Getting there means either a real NAT gateway with per-destination or
per-pod SNAT mapping (a meaningfully bigger and more expensive piece of
infrastructure than "a $12/month worker node"), or a per-node public IP
scheme where you deliberately run at most one tenant pod per node (at which
point you are paying for N nodes, not N pods on shared nodes, and the
whole "cheap K8s" pricing premise in the research no longer holds — see
§4). Either way, the pricing figures quoted ($10-24/month) describe the
shared-egress shape (A), not this one. Nobody quoting Civo/Vultr/DOKS at
those prices is pricing per-pod public IPs.

**Conclusion for this section:** pod-per-tenant is only coherent under
shape B, shape B is not what the cheap-K8s pricing research describes, and
shape A — the shape actually on offer at that price — is strictly worse
than what exists today: same shared ceiling, minus the one component
(`RateLimiter`) that currently arbitrates it fairly, plus a distributed
system you'd have to build and operate to replace it.

---

## 2. What pod-per-tenant would actually buy, versus what's already true

The pitch for pod-per-tenant is usually isolation: one tenant's bug or crash
shouldn't be able to affect another's. Worth checking how much of that is
already true, because the app's internal architecture (`control-plane-data-
plane.md`) already draws the Kubernetes analogy at the *ship* level, not
the *process* level — and that has application-layer answers to most of
what a pod boundary would provide at the infrastructure level.

**Crash isolation.** `TenantRegistry.boot()` starts each tenant's coordinator
loop and scheduler as detached, caught promises:
`fleet.run(RUN_FOREVER_TICKS).catch((err) => log(...))` and
`scheduler.run(RUN_FOREVER_TICKS).catch((err) => log(...))`
(`tenantRegistry.ts:445, 451`). An uncaught rejection inside one tenant's
tick loop is logged and stops that tenant's loop — it does not propagate and
does not take down the process or any other tenant's loop, because each is
its own `.catch()`-terminated promise chain, not a shared call stack. This is
real, already-working fault isolation at the application layer for the
failure mode that matters most (a bug in the fleet/agent logic throwing).
Pod-per-tenant would not improve on this case; it already fails the same
way — the affected tenant stops, everyone else keeps running.

What pod-per-tenant *would* isolate that the current design doesn't:
- **A genuinely process-fatal event** — an OOM from one tenant's data
  ballooning (e.g. `MarketIntel`, `GalaxyAtlas`'s in-memory registry, or
  `FleetState` growing unboundedly for one very large fleet), a native
  module crash, or a synchronous infinite loop that starves the event loop
  for everyone. These are real but rare categories for this codebase's
  shape (mostly I/O-bound async work, per `docs/adr/0005`'s own "sizing is
  bottlenecked by SpaceTraders' rate limit, not CPU"), and nothing in the
  bug history surfaced in this codebase's docs describes one actually
  happening.
- **Resource contention** — one tenant's background market-refresh scan
  (`tenantRegistry.ts:586-607`) or a large `store.recordMarkets()` batch
  competing for the same connection pool or CPU as another tenant's request.
  This is real today (see §3) but is a resource-sharing problem, not a
  security or correctness one — RLS still enforces data isolation
  regardless of process topology (`docs/architecture-plan.md §2`).

**Data isolation** is already handled at a layer pod-per-tenant wouldn't
change at all: Postgres RLS, enforced by the database itself, with `FORCE
ROW LEVEL SECURITY` so even the table owner can't bypass it
(`docs/architecture-plan.md:128-140`, confirmed live in `pool.ts`'s own
comment about the `withTenant()` investigation). ADR 0002 explicitly
rejected schema-per-tenant as unnecessary given RLS. Pod-per-tenant doesn't
touch this axis; the isolation story here is orthogonal to what OS process
or pod a tenant's engine runs in.

**Honest framing:** pod-per-tenant buys real protection against a narrow,
currently-unobserved failure class (process-fatal bugs, OOM, event-loop
starvation) at the cost of solving a data-isolation problem that's already
solved and reproducing a rate-limit problem that's already solved better
than the redesign would leave it. That's a real but thin case, not a strong
one, at 3 tenants.

---

## 3. What breaks or gets harder

**Shared galaxy/topology cache.** The `Registry` model in
`control-plane-data-plane.md §3` is explicitly "one in-memory object per
tenant... a reference, never a copy," and its own "multi-process later" note
says plainly: "if this ever runs as more than one instance, the registry
stops being a shared reference and needs `LISTEN/NOTIFY` or a channel. One
tenant, one process: keep it in memory" (`control-plane-data-plane.md:212-
214`). That note is *already* about exactly this migration, written before
this document existed. Since a pod-per-tenant topology is naturally one
process per tenant, each tenant's registry stays intra-pod and doesn't need
to become distributed *for that tenant's own data* — but market/shipyard
data is not actually private per tenant (`docs/architecture-plan.md:81-85`:
market snapshots, shipyard inventory, and the module catalog are explicitly
un-scoped, shared galaxy data, "the same rows for everyone"). Today that
shared data is cached once, process-wide, and read by every tenant's agents
in the same system without a network hop. Pod-per-tenant means either N
pods each independently re-fetching and re-caching the same public galaxy
data from Postgres (and from SpaceTraders, for anything not yet in the DB —
see `tenantRegistry.ts:293-313`'s cached-vs-live-scan logic, which already
exists as a workaround for cold caches and would now apply per pod, not
once per process), or standing up a real shared cache service. Either is
new work the current design doesn't need.

**DB connection pool.** Today: one `pg.Pool` per process, `max: 20`
(`src/db/pool.ts:74`), shared across all 3 tenants — sized once, against pg's
default-10 bottleneck already found in production (`pool.ts:66-73`'s
comment: a dashboard login's ~9 parallel requests plus background refresh
already contends for it). Pod-per-tenant means N independent pools, one per
pod, each opening its own connections to the same Postgres instance. At 3
tenants with pools sized similarly that's up to 60 connections instead of 20
against one process's pool — and the instance in question is shared with an
unrelated production app in its `public` schema on the same Postgres server
(`docs/adr/0005-...md:14-17`), so its total connection ceiling is not sized
for this app alone. This gets worse, not better, as tenant count grows,
because pool sizing no longer amortizes across tenants sharing one process —
it multiplies per pod.

There's a genuine open question about where that Postgres instance actually
sits relative to a hypothetical K8s cluster. `pool.ts`'s own comments
describe it as Render-hosted (`pool.ts:37-60` discusses Render's internal
vs. external hostname and TLS behavior explicitly, and ADR 0005 names it as
"promptoria-db," a Render Postgres instance shared with another app), which
would put today's web-service-to-Postgres traffic on Render's private
network. Separately, direct investigation of the current Render workspace's
own Postgres instance list didn't turn up this database — meaning either
it belongs to a different Render account/workspace than the one hosting
`stcommand`, or `DATABASE_URL` in production points somewhere the generic
`.env.example` doesn't reveal. Either way, this app's database connection is
**not confirmed to be same-network with the app today**, and a move to an
external K8s cluster (Civo/Vultr/DOKS, none of which are Render) makes this
worse in the same direction regardless of which reading is correct: N pods'
worth of connections now cross whatever network boundary already exists
between the app and Postgres, each pod paying that latency/TLS-handshake
cost independently at boot rather than once per process. This is worth
nailing down for its own sake before any K8s decision, not just because of
this document.

**Deploy/restart behavior.** Today, every deploy restarts the entire
process: all 3 tenants' fleets stop and reboot together, immediately
re-triggering `bootAll()`'s eager-boot sweep (`docs/adr/0009`) and the boot-
priority dance in `tenantRegistry.ts:261-275`'s `setPriority(0)` boost. This
is a real, if minor, downside today, and the ADR that introduced eager-boot
frames it as damage control for exactly this restart behavior, not a
solution to it. Kubernetes' native rolling-deploy model — replacing one pod
at a time, on its own readiness signal — would turn "every tenant restarts
together" into "tenants restart independently, staggered." That's a genuine
improvement, and it's the strongest operational argument for K8s *of any
kind* raised in this exploration. It does not require pod-per-tenant,
though (see §5) — a single K8s Deployment with multiple replicas of the
current *whole-process* server gets the same rolling-restart benefit without
touching the tenant-topology question at all, and without triggering the
whole rate-limiter redesign in §1. It's also worth noting the eager-boot
priority boost exists specifically to avoid *thundering-herd* contention
against the shared rate limiter on every restart (`tenantRegistry.ts:56-
66`'s `BOOT_RETRY_COOLDOWN_MS` comment describes exactly this failure mode
from repeated boot attempts); staggering pod restarts would reduce how often
that boost logic is exercised, which is a real if modest win.

**Operational complexity.** Today: push to `main`, Render builds and
deploys one service. The commit history and the directness of these docs
(first-person investigation notes, ADRs written by whoever made the call,
no multi-person review process visible) point to a one-person or very small
operation. Pod-per-tenant on K8s means, at minimum: Kubernetes manifests or
a Helm chart, a container image build/push step, per-tenant Secret objects
for SpaceTraders tokens (currently just encrypted columns in one `tenants`
table, `architecture-plan.md:92-107`), a Deployment (or equivalent) created
and torn down *dynamically* as tenants sign up and churn — which is new
machinery the current design doesn't need at all, since `TenantRegistry`
just adds a `Map` entry — plus whatever ingress/routing layer sends a given
tenant's dashboard traffic to their specific pod. None of this is
hard in the abstract; all of it is real ongoing maintenance surface for a
team of one, for a benefit (§2) that's currently thin.

---

## 4. Cost, concretely, at today's and near-future scale

**Today.** One Render web service, `starter` plan
(`serviceDetails.plan`). Render's published starter-tier web service pricing
has moved around over time and isn't something this exploration can verify
with confidence from inside the repo — worth checking Render's current
pricing page directly rather than trusting a number here, but it's a single
low-tens-of-dollars-per-month instance either way, running all 3 tenants
today.

**Pod-per-tenant at 3 tenants.** Using the pricing research as given: a
managed control plane is free on all three providers (Civo, Vultr/VKE,
DOKS), so the cost is worker-node compute. Even if 3 tenant pods could
tightly pack onto one $12/month single-worker-node cluster (DOKS's
cheapest tier), that's *not actually pod-per-tenant isolation* — three pods
sharing one node share that node's CPU, memory, and (per §1) its one egress
IP, which is exactly shape A above. Real per-tenant isolation on a cheap
provider means either one node per tenant (3 × ~$6-12/month depending on
provider ≈ $18-36/month) or accepting shared-node placement and giving up
the isolation argument this whole redesign exists for. Either way this is
already more expensive and more complex than the current single Render
instance, for the reasons in §§1-3, with no clear win to show for it at this
scale.

**At 10-20 tenants.** This is where pod-per-tenant's cost story gets
structurally worse, not better, because **every pod needs baseline resources
even for a near-idle tenant.** A tenant's fleet loop ticks every 2 seconds
regardless of activity (`docs/adr/0005`: "a tenant's engine keeps running
whether or not their dashboard tab is open" is stated as the product's core
premise, not incidental), so there's no natural way to scale a pod to zero
between ticks the way a request-scoped serverless function could. At 10-20
tenants, real per-tenant node isolation means 10-20 nodes at ~$6-12/month
each — $60-240/month — purely for compute that the current single process
already handles inside one Render instance, because the current design's
whole resource story is "N tenants share one process's memory and one
event loop," which amortizes fine at this scale (ADR 0005 again: "sizing is
bottlenecked by SpaceTraders' own 2 req/s per-tenant rate limit, not CPU").
Compare: the current single-process model's cost barely moves as tenant
count grows from 3 to 20, because the bottleneck (API rate limit, Postgres
pool) is the same shared resource either way and Render's instance sizing
is about the process's own CPU/memory headroom, which 20 mostly-I/O-bound
tenant loops don't meaningfully stress. Pod-per-tenant's cost scales
roughly linearly with tenant count from the start; the current model's
doesn't, until you hit an actual CPU or memory ceiling that nothing in this
codebase's docs suggests is close.

---

## 5. A middle ground, named honestly

Two things worth separating, because the pitch conflates them:

1. **"We want Kubernetes-style rolling deploys / better restart behavior."**
   Solvable today, on any of the three cheap providers, with a single
   Deployment running the *existing* whole-process, all-tenants server —
   no pod-per-tenant, no rate-limiter redesign, no per-tenant Secrets or
   dynamic manifest management. Rolling replica updates already give you
   independent-of-tenant-count restart staggering. This captures the one
   genuinely strong operational argument in §3 without touching anything in
   §1 that doesn't work at this price point.
2. **"We want per-tenant blast-radius isolation."** Per §2, most of what
   this would buy is already true at the application layer (RLS for data,
   per-tenant caught promise chains for crash isolation). What isn't
   already true (OOM, event-loop starvation, native-module crashes) is a
   real but currently-unobserved risk category — nothing in this codebase's
   bug history (the very detailed one in `control-plane-data-plane.md §1`,
   or `docs/bug-log.md`) describes it happening. If it does start
   happening, the fix that matches the actual failure mode is worth
   revisiting then, with a real incident to design against instead of a
   hypothetical one.

If the goal is genuinely "give every tenant their own real 2 req/s from
SpaceTraders" (shape B in §1) — which is the only version of this idea with
an unambiguous upside — the honest note is that this is achievable *without
Kubernetes at all*: it only requires each tenant's traffic to originate
from a distinct public IP, which is a NAT/networking problem, not a
container-orchestration problem. Solving it doesn't require adopting pods,
manifests, or per-tenant deployments; it only requires an egress path per
tenant, which could in principle be layered onto the *current* single-
process design (e.g. per-tenant outbound proxies) without moving off Render
or touching the process topology at all. Whether that's worth doing is a
separate question from Kubernetes, and only becomes worth asking if
SpaceTraders 429 pressure from the shared 2 req/s ceiling actually starts
constraining growth — which, per `docs/rate-limiter-saturation-plan.md:86-
90`'s own assessment, it explicitly doesn't yet ("three tenants at 1.5 req/s
shared is not close to the failure mode this protects against").

---

## 6. Recommendation

There is no strong case for pod-per-tenant Kubernetes right now, and the
reasoning holds up whether you're being generous or skeptical about the
idea. The single fact that decides it — SpaceTraders' per-IP rate limit — is
already documented in three places in this codebase
(`client.ts:28-42`, `tenantRegistry.ts:73-84`, `control-plane-data-plane.md
:307-311`) as the reason the *current* one-process design exists, and moving
to pods doesn't change that constraint; on the cheap providers actually
priced in the research, it makes the constraint harder to manage, not
easier, because you lose the one component (`RateLimiter`) that currently
handles it well and have to rebuild an equivalent as a distributed system.
Everything else pod-per-tenant would offer — crash isolation, per-tenant
scaling — is either already true today at the application layer, or scales
in the wrong direction (linear per-tenant infrastructure cost against a
workload whose current bottleneck, the API rate limit, doesn't scale with
tenant count at all).

**Don't migrate to pod-per-tenant K8s at this scale.** If deploy-time
restarts become a real pain point, address that narrowly with a same-
architecture Deployment behind rolling updates (§5.1) rather than adopting
the tenant-isolation redesign to get there. If per-tenant SpaceTraders
throughput genuinely becomes a growth ceiling — which nothing in this
repo's own saturation analysis says it is yet — the fact that actually
unlocks more throughput is a distinct public IP per tenant (§5, shape B),
and that's worth pursuing directly rather than backing into it as a side
effect of a much larger infrastructure migration. Revisit this document if
either of those becomes real, or once tenant count is large enough that "3
today" stops being the operative number — but not before.
