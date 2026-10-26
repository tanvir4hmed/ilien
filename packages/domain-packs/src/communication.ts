/** Explicit disclosure allowlist, never an AI-generated summary of the source. */
export function communicationContext(
  original: unknown,
  group: string,
): Record<string, unknown> {
  if (!original || typeof original !== "object") return {};
  const event = original as {
    eventType?: string;
    payload?: Record<string, unknown>;
  };
  const fields =
    event.eventType &&
    [
      "manufacturing.material_readiness_requested",
      "planning.upstream_supply_shifted",
      "manufacturing.production_coordination_requested",
    ].includes(event.eventType)
      ? ["siteId", "materialLotId", "requiredQuantity", "neededBy"]
      : event.eventType === "maintenance.breakdown_logged"
        ? ["siteId", "machineId", "faultCode"]
        : event.eventType === "plm.techpack_approved"
          ? ["siteId", "techpackId", "styleId", "revision"]
          : [];
  const groups = [
    "stores",
    "quality",
    "planning",
    "procurement",
    "production",
    "supplier",
    "maintenance",
  ];
  if (!groups.includes(group)) return {};
  return Object.fromEntries(
    fields
      .filter((k) => event.payload?.[k] !== undefined)
      .map((k) => [k, event.payload![k]]),
  );
}
