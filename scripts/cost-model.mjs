#!/usr/bin/env node
// Estimate the monthly Azure + model cost of an AgentForEach deployment.
// Every input is a flag; defaults and where they come from are in docs/costs.md.
//
//   node scripts/cost-model.mjs --users 100000
//   node scripts/cost-model.mjs --users 1000000 --turns 120 --online 0.1 --json

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// Azure list prices, East US, USD, from the Azure Retail Prices API on 29 Sep 2026.
export const PRICES = {
  functionsGbSecond: 0.000026,      // Flex Consumption on-demand execution time
  functionsFreeGbSeconds: 100_000,  // monthly free grant per subscription
  functionsPerMillionExecutions: 0.40,
  functionsFreeExecutions: 250_000,
  cosmosPerMillionRu: 0.25,         // serverless
  cosmosGbMonth: 0.25,
  pubsubUnitDay: 1.61,              // Standard: 1,000 connections and 1M messages a day per unit
  pubsubPerMillionMessages: 1.0,    // beyond the units' included messages
  logAnalyticsGb: 2.30,
  logAnalyticsFreeGb: 5,
  queuePer10kOps: 0.004,            // Durable Functions task hub (Azure Storage queues)
  b1sVmHour: 0.0104,                // smallest general-purpose VM, for the machine-per-user comparison
};

export const DEFAULTS = {
  users: 100_000,
  turns: 60,             // turns per user per month (about two a day)
  online: 0.05,          // share of users connected at the busiest moment
  model1k: [1.72, 2.19], // model cost per 1,000 turns, measured with GPT-5.6 Luna
  ru: 200,               // Cosmos request units per turn (estimated from the operations a turn performs)
  turnSeconds: 5.4,      // a turn's duration, p50 with GPT-5.6 Luna (measured)
  turnsPerInstance: 12,  // turns one 2 GB instance runs at once (measured: ~84 in flight on 7 instances at 1,000 users)
  instanceGb: 2,         // Flex Consumption instance memory (infra/functions.ts)
  executions: 4,         // Functions executions per turn (HTTP, orchestrator x2, activity)
  messages: 16,          // Web PubSub messages per turn (thinking, deltas every 400 ms, final)
  logKb: 20,             // Log Analytics KB per turn
  queueOps: 50,          // Durable Functions storage operations per turn
  mbPerUser: 3,          // Cosmos storage per user (memories and episodes keep their embeddings)
};

const HOURS_PER_MONTH = 730;
const DAYS_PER_MONTH = HOURS_PER_MONTH / 24;
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;

export function estimate(input = {}) {
  const a = { ...DEFAULTS, ...input };
  const p = PRICES;
  const turns = a.users * a.turns;

  // Flex bills an instance's memory while it runs at least one turn. With turns spread over the
  // month, `inFlight` turns run at once on average: at low volume one instance is often busy with
  // a single turn; at high volume turns share instances.
  const inFlight = turns / SECONDS_PER_MONTH * a.turnSeconds;
  const instances = Math.max(inFlight / a.turnsPerInstance, 1 - Math.exp(-inFlight));
  const gbSeconds = instances * a.instanceGb * SECONDS_PER_MONTH;
  const functions =
    Math.max(0, gbSeconds - p.functionsFreeGbSeconds) * p.functionsGbSecond +
    Math.max(0, turns * a.executions - p.functionsFreeExecutions) / 1e6 * p.functionsPerMillionExecutions;
  const cosmosRu = turns * a.ru / 1e6 * p.cosmosPerMillionRu;
  const units = Math.max(1, Math.ceil(a.users * a.online / 1000));
  const messagesPerDay = turns * a.messages / DAYS_PER_MONTH;
  const pubsub = units * p.pubsubUnitDay * DAYS_PER_MONTH +
    Math.max(0, messagesPerDay - units * 1e6) * DAYS_PER_MONTH / 1e6 * p.pubsubPerMillionMessages;
  const logs = Math.max(0, turns * a.logKb / 1e6 - p.logAnalyticsFreeGb) * p.logAnalyticsGb;
  const queues = turns * a.queueOps / 1e4 * p.queuePer10kOps;
  const storage = a.users * a.mbPerUser / 1000 * p.cosmosGbMonth;

  const platform = functions + cosmosRu + pubsub + logs + queues + storage;
  const model = a.model1k.map((m) => turns / 1000 * m);
  const machinePerUser = p.b1sVmHour * HOURS_PER_MONTH;

  return {
    assumptions: a,
    turns,
    pubsubUnits: units,
    averageInstances: instances,
    platform: { functions, cosmosRu, pubsub, logs, queues, storage, total: platform, perUser: platform / a.users },
    model: { low: model[0], high: model[1] },
    total: { low: platform + model[0], high: platform + model[1] },
    machinePerUser: { perUser: machinePerUser, total: machinePerUser * a.users },
    idleUserPerMonth: a.mbPerUser / 1000 * p.cosmosGbMonth,
  };
}

const usd = (n) => '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(n >= 1 ? 2 : 4));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      users: { type: 'string' }, turns: { type: 'string' }, online: { type: 'string' },
      ru: { type: 'string' }, messages: { type: 'string' },
      'log-kb': { type: 'string' }, 'mb-per-user': { type: 'string' }, json: { type: 'boolean' },
    },
  });
  const num = (v) => (v === undefined ? undefined : Number(v));
  const input = Object.fromEntries(Object.entries({
    users: num(values.users), turns: num(values.turns), online: num(values.online), ru: num(values.ru),
    messages: num(values.messages), logKb: num(values['log-kb']), mbPerUser: num(values['mb-per-user']),
  }).filter(([, v]) => v !== undefined));
  const r = estimate(input);
  if (values.json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  const pl = r.platform;
  console.log(`${r.assumptions.users.toLocaleString('en-US')} users, ${r.assumptions.turns} turns each a month (${r.turns.toLocaleString('en-US')} turns)\n`);
  console.log(`  Functions compute        ${usd(pl.functions)}`);
  console.log(`  Cosmos DB requests       ${usd(pl.cosmosRu)}`);
  console.log(`  Cosmos DB storage        ${usd(pl.storage)}`);
  console.log(`  Web PubSub (${r.pubsubUnits} unit${r.pubsubUnits > 1 ? 's' : ''})     ${usd(pl.pubsub)}`);
  console.log(`  Logs                     ${usd(pl.logs)}`);
  console.log(`  Durable task hub         ${usd(pl.queues)}`);
  console.log(`  Platform total           ${usd(pl.total)}  (${usd(pl.perUser)} per user)`);
  console.log(`  Model tokens             ${usd(r.model.low)} to ${usd(r.model.high)}`);
  console.log(`  Everything               ${usd(r.total.low)} to ${usd(r.total.high)} a month\n`);
  console.log(`  An idle user: ${usd(r.idleUserPerMonth)} a month of storage.`);
  console.log(`  A machine per user instead: ${usd(r.machinePerUser.total)} a month before any work is done.`);
}
