import type { components } from "../core/client.js";

export type Ship = components["schemas"]["Ship"];
export type Agent = components["schemas"]["Agent"];
export type Contract = components["schemas"]["Contract"];

/** A shared, periodically-refreshed snapshot of fleet state for the dashboard. */
export interface SystemView {
  symbol: string;
  waypoints: { symbol: string; x: number; y: number; type: string; traits: string[] }[];
  jumpGates: string[];
  /** The system's own star type (galaxy_systems.system_type — RED_STAR,
   *  BLUE_STAR, etc., SpaceTraders' SystemType), when the galaxy crawl has
   *  learned it. Undefined for a system no crawl pass has reached yet. */
  type?: string;
}

export interface FleetSnapshot {
  agent: Agent | null;
  ships: Ship[];
  contracts: Contract[];
  systemSymbol: string;
  waypoints: { symbol: string; x: number; y: number; type: string; traits: string[] }[];
  systems: SystemView[];
  jumpConnections: { from: string; to: string }[];
  totals: { credits: number; buys: number; sells: number };
  updatedAt: string;
}

/** In-memory state holder shared between the engine and the web server. */
export class FleetState {
  private snapshot: FleetSnapshot = {
    agent: null,
    ships: [],
    contracts: [],
    systemSymbol: "",
    waypoints: [],
    systems: [],
    jumpConnections: [],
    totals: { credits: 0, buys: 0, sells: 0 },
    updatedAt: new Date().toISOString(),
  };

  update(s: Partial<FleetSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...s, updatedAt: new Date().toISOString() };
  }

  get(): FleetSnapshot {
    return this.snapshot;
  }
}
