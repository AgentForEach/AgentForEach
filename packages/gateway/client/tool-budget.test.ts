/**
 * Soft tool budget — the enforced replacement for the prose round-target.
 *
 * The TOOLS prompt document used to say "complete any new contract in ~8-10
 * tool rounds", which the correct workflow could not satisfy and the runtime
 * did not enforce. The budget is now config (`llms.toolBudget`) applied by the
 * runner: one model-visible convergence note at the soft threshold, and the
 * existing `maxToolRounds` hard stop unchanged.
 *
 *   npx tsx --test packages/gateway/client/tool-budget.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applySoftBudgetWarning } from "./runner.js";

const outputs = (...texts: string[]) => texts.map((output) => ({ output }));

test("warns on the last tool output when the soft threshold is reached", () => {
  const outs = outputs("first result", "second result");
  const warned = applySoftBudgetWarning(outs, {
    round: 12,
    maxRounds: 20,
    softBudget: 12,
    alreadyWarned: false,
  });

  assert.equal(warned, true);
  assert.equal(outs[0].output, "first result", "earlier outputs untouched");
  assert.match(outs[1].output, /^second result/, "the tool result itself survives");
  assert.match(outs[1].output, /12 tool rounds used; 8 remain/, "counts are real");
  assert.match(outs[1].output, /Converge/, "the note asks for convergence, not panic");
});

test("stays silent below the threshold", () => {
  const outs = outputs("result");
  const warned = applySoftBudgetWarning(outs, {
    round: 11,
    maxRounds: 20,
    softBudget: 12,
    alreadyWarned: false,
  });
  assert.equal(warned, false);
  assert.equal(outs[0].output, "result");
});

test("fires once per run — alreadyWarned suppresses it", () => {
  const outs = outputs("result");
  const warned = applySoftBudgetWarning(outs, {
    round: 15,
    maxRounds: 20,
    softBudget: 12,
    alreadyWarned: true,
  });
  assert.equal(warned, false);
  assert.equal(outs[0].output, "result");
});

test("no budget configured means no note ever", () => {
  const outs = outputs("result");
  const warned = applySoftBudgetWarning(outs, {
    round: 19,
    maxRounds: 20,
    softBudget: undefined,
    alreadyWarned: false,
  });
  assert.equal(warned, false);
  assert.equal(outs[0].output, "result");
});

test("past the hard cap the note still promises at least one round", () => {
  const outs = outputs("result");
  applySoftBudgetWarning(outs, {
    round: 25,
    maxRounds: 20,
    softBudget: 12,
    alreadyWarned: false,
  });
  assert.match(outs[0].output, /1 remain/, "never claims zero or negative rounds");
});
