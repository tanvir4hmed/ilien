import { query, param, rows } from "../../persistence/src/database.js";
import type { Source } from "../../coordination/src/service.js";
export type Stage = "intake" | "agent" | "outbound" | "results";
export interface Controls {
  revision: number;
  intake_paused: boolean;
  agent_paused: boolean;
  outbound_paused: boolean;
  results_paused: boolean;
  retention_days: number;
  legal_hold: boolean;
}
export async function controlsFor(source: Source, tx: string, lock = false) {
  const row = rows<Controls>(
    await query(
      `SELECT revision,intake_paused,agent_paused,outbound_paused,results_paused,retention_days,legal_hold FROM operations_controls WHERE connection_id=CAST(:source AS uuid)${lock ? " FOR UPDATE" : ""}`,
      [param("source", source.id)],
      tx,
    ),
  )[0];
  if (!row) throw new Error("Operations controls unavailable");
  return row;
}
export async function pausedFor(source: Source, stage: Stage, tx: string) {
  return (await controlsFor(source, tx))[`${stage}_paused`];
}
