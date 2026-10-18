# Agent Development Guide: stcommand (Standing Orders)

This guide is for AI agents tasked with developing, maintaining, or extending the `stcommand` fleet engine. This repository implements a multi-tenant autonomous SpaceTraders fleet engine with a strict separation between the **Control Plane** (scheduling, budget, coordination) and the **Data Plane** (ship actions, state transitions).

## 1. System Architecture

### 1.1 Core Philosophy: Control Plane vs. Data Plane
The most critical architectural constraint in this repo is the **Non-Blocking Data Plane**. 
- **Control Plane (`src/engine/scheduler.ts`):** Manages the priority queue of `Task`s. It admits tasks based on a token-bucket budget.
- **Data Plane (Agents in `src/engine/*.ts`):** Implements ship logic. **Data plane code must NEVER use `await sleep()` or block the thread.**
- **The `Pending` Signal:** If a ship must wait (transit, cooldown, backoff), it must throw a `Pending` exception (or subclass like `NavigationPending`). The `Scheduler` catches this and reschedules the task for the exact `resumeAt` time. Blocking the thread in the data plane halts the entire tenant's fleet.

### 1.2 Domain Model
- **Multi-Tenancy:** The system supports multiple independent fleets. Tenant isolation is enforced via PostgreSQL **Row Level Security (RLS)**.
- **`TenantRegistry`:** Handles the lifecycle of tenant fleets.
- **`Scheduler`:** The heartbeat of each tenant. Coordinates `Task` execution across all ships.
- **`Dispatcher` (`src/engine/dispatcher.ts`):** The "Brain". It computes profitable routes and assigns `TraderAssignment`s to ships to prevent market saturation.
- **`Agent` classes:**
    - `ShipAgent`: Basic survival/mining loop.
    - `TraderAgent`: Executes complex trade routes assigned by the Dispatcher.
    - `ScoutAgent` / `SiphonerAgent`: Specialized roles for exploration and resource extraction.

## 2. Development Workflow

### 2.1 Adding New Logic
When implementing a new feature (e.g., a new ship role or a new dispatching rule):
1. **Define the State:** Update `src/core/schema.d.ts` or the relevant DB table if persistence is needed.
2. **Implement the Logic:** 
    - If it's a ship behavior, add a new `Agent` class or extend an existing one.
    - If it's a coordination rule, modify `src/engine/dispatcher.ts`.
3. **Integrate with Scheduler:** Ensure the new behavior is wrapped in a `Task` and enqueued via the `Scheduler`.

### 2.2 Testing
The repository uses the native Node.js test runner with `tsx`.
- **Run all tests:** `npm test`
- **Test Environment:** Uses `.env.test` for database and API keys.
- **TDD Pattern:** Create a `.test.ts` file in `tests/` corresponding to the logic in `src/`.

### 2.3 Build & Deployment
- **Typechecking:** `npm run typecheck` (runs `tsc --noEmit`).
- **Build:** `npm run build` (compiles TS to `dist/` using `tsconfig.build.json`).
- **Execution:** The server boots from `src/cli/index.ts` in dev or `dist/cli/index.js` in prod.

## 3. Technical Constraints & Pitfalls

### 3.1 API Rate Limiting
The `Scheduler` has its own budget, and the `Client` has a transport-layer limiter. 
- **Pitfall:** Setting a task's `estimatedCalls` too high can cause it to be permanently starved if it exceeds the scheduler's burst limit.
- **Rule:** Keep `estimatedCalls` realistic. Use `priority 0` for rescue tasks to ensure they bypass most blocks.

### 3.2 Database Access
- **Rule:** Always use the `Store` class for DB operations. 
- **RLS:** Do not manually add `WHERE tenant_id = ...` to queries in the `Store` class; this is handled by the `withTenant` wrapper via Postgres RLS.

### 3.3 Memory and State
- **Universe Resets:** The system is aware of SpaceTraders' weekly resets. Ensure that durable history (logs, metrics) is attributed to the correct `universeKey`.

## 4. Key File Reference

| File | Purpose |
|---|---|
| `src/engine/scheduler.ts` | Task queue, budget admission, and execution loop. |
| `src/engine/dispatcher.ts` | Route calculation and ship assignment logic. |
| `src/engine/agentStep.ts` | Definition of `Pending` and `AgentStep` for non-blocking waits. |
| `src/db/store.ts` | Tenant-scoped database abstraction. |
| `src/cli/index.ts` | Server entry point and multi-tenant boot sequence. |
