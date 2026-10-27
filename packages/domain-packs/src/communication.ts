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
  // The source explicitly declares which context is intended for each recipient.
  // Unlabelled arbitrary fields remain private until a disclosure profile maps them.
  const context=event.payload?.communicationContext;
  if(context && typeof context==="object" && !Array.isArray(context)) {
    const scoped=(context as Record<string,unknown>)[group];
    if(scoped && typeof scoped==="object" && !Array.isArray(scoped))return {...scoped as Record<string,unknown>};
  }
  if(event.eventType==="communication.request_raised" && event.payload?.context && typeof event.payload.context==="object")return {context:event.payload.context};
  const fields =
    event.eventType &&
    [
      "manufacturing.material_readiness_requested",
      "planning.upstream_supply_shifted",
      "manufacturing.production_coordination_requested",
      "manufacturing.dispatch_exception_requested",
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
