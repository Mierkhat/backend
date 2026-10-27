/** Measures a committed two asset / two swap invocation against current protocol limits. */
import { readFile, writeFile } from "node:fs/promises";
import { rpc, xdr, scValToNative, Transaction } from "@stellar/stellar-sdk";
import { bundleSchema, txV1 } from "../src/index.js";
const b = bundleSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../deployments/index.json", import.meta.url),
        "utf8",
      ),
    )[0],
  ),
  s = new rpc.Server("https://soroban-testnet.stellar.org", { timeout: 12000 }),
  journey = JSON.parse(
    await readFile(
      new URL(
        "../../../contracts/evidence/testnet-journey.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const result = await s.getTransaction(journey.operations.exit.hash);
if (result.status !== "SUCCESS" || result.resultMetaXdr.type !== "v4")
  throw Error("Committed protocol 29 metadata required");
const metrics: Record<string, number> = {};
for (const event of result.resultMetaXdr.v4.diagnosticEvents) {
  if (event.event.body.type !== "v0") continue;
  const v = event.event.body.v0,
    topics = v.topics.map(scValToNative);
  if (topics[0] === "core_metrics")
    metrics[String(topics[1])] = Number(scValToNative(v.data));
}
const ids = [
  "configSettingContractComputeV0",
  "configSettingContractLedgerCostV0",
  "configSettingContractEventsV0",
  "configSettingContractBandwidthV0",
  "configSettingContractLedgerCostExtV0",
  "configSettingContractDataKeySizeBytes",
  "configSettingContractDataEntrySizeBytes",
] as const;
const keys = ids.map((id) =>
    xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({
        configSettingId: xdr.ConfigSettingId[id],
      }),
    ),
  ),
  entries = await s.getLedgerEntries(...keys);
const settings = Object.assign(
  {},
  ...JSON.parse(JSON.stringify(entries)).entries.map(
    (e: any) => e.val.config_setting,
  ),
);
const compute = settings.contract_compute_v0,
  io = settings.contract_ledger_cost_v0,
  events = settings.contract_events_v0,
  bandwidth = settings.contract_bandwidth_v0,
  ext = settings.contract_ledger_cost_ext_v0;
const tx = new Transaction(result.envelopeXdr, b.networkPassphrase),
  body = txV1(tx);
if (body.ext.type !== "sorobanData") throw Error("Resources missing");
const resources = body.ext.sorobanData.resources;
const values: [string, number, number][] = [
  [
    "instructions",
    Math.max(metrics.cpu_insn!, resources.instructions),
    Number(compute.tx_max_instructions),
  ],
  ["memoryBytes", metrics.mem_byte!, compute.tx_memory_limit],
  [
    "diskReadBytes",
    Math.max(metrics.ledger_read_byte!, resources.diskReadBytes),
    io.tx_max_disk_read_bytes,
  ],
  [
    "writeBytes",
    Math.max(metrics.ledger_write_byte!, resources.writeBytes),
    io.tx_max_write_bytes,
  ],
  [
    "footprintEntries",
    resources.footprint.readOnly.length + resources.footprint.readWrite.length,
    ext.tx_max_footprint_entries,
  ],
  [
    "writeEntries",
    resources.footprint.readWrite.length,
    io.tx_max_write_ledger_entries,
  ],
  [
    "eventsAndReturnBytes",
    metrics.emit_event_byte! + (result.returnValue?.toXDR().length ?? 0),
    events.tx_max_contract_events_size_bytes,
  ],
  [
    "transactionBytes",
    result.envelopeXdr.toXDR().length,
    bandwidth.tx_max_size_bytes,
  ],
  [
    "largestDataKeyBytes",
    metrics.max_rw_key_byte!,
    settings.contract_data_key_size_bytes,
  ],
  [
    "largestDataEntryBytes",
    metrics.max_rw_data_byte!,
    settings.contract_data_entry_size_bytes,
  ],
];
const comparisons = values.map(([resource, used, limit]) => ({
  resource,
  used,
  limit,
  headroomPercent: ((limit - used) * 100) / limit,
  passes:
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    used >= 0 &&
    limit > 0 &&
    used <= limit * 0.8,
}));
if (comparisons.some((v) => !v.passes))
  throw Error(
    "Insufficient or unmeasured headroom: " + JSON.stringify(comparisons),
  );
const evidence = {
  checkedAt: new Date().toISOString(),
  network: b.networkPassphrase,
  protocol: Number((await s.getNetwork()).protocolVersion),
  settingsLedger: entries.latestLedger,
  transactionHash: journey.operations.exit.hash,
  transactionLedger: result.ledger,
  route: {
    assets: b.profile.assets.length,
    swaps: b.profile.assets.filter((a) => a.pair).length,
  },
  metrics,
  declaredResources: JSON.parse(JSON.stringify(resources)),
  settings,
  comparisons,
  allMeasuredLimitsHaveAtLeast20PercentHeadroom: true,
  scope:
    "Committed strategy free two asset direct route. Different profiles and cold archived footprints require their own measurements.",
};
await writeFile(
  new URL(
    "../../../contracts/evidence/testnet-resource-headroom.json",
    import.meta.url,
  ),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "PASS committed network metrics and current protocol limits",
  comparisons,
);
