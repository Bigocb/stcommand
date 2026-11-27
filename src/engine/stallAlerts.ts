/**
 * The engine-stall alerts the health recorder (healthRecorder.ts) has raised and not yet cleared, by tenant id. The
 * notification pass reads it into its snapshot (notify/live.ts) and the health detector turns it into a push. A tiny
 * module with no imports on purpose, so the notification code does not pull in the health board.
 */
export interface StallAlert {
  /** New for each stall, so a device is told once per stall and again for the next one. */
  key: string;
  title: string;
  body: string;
}

export const stallAlerts = new Map<string, StallAlert>();

/** The box-CPU alerts (cpuHealth.ts), by tenant id, held while the hot spell lasts. Same shape as a stall alert. */
export const cpuAlerts = new Map<string, StallAlert>();
