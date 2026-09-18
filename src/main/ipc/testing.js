"use strict";
/* IPC: the Test Director — testdir:* (per-project test catalog, selection, runs, goals), testhost:run
 * (the embedded-browser executor) and director:* (the goal→green orchestrator). Backed by
 * src/main/testing/. */

function register(ctx) {
  const { handle } = ctx;
  // ---- Test Director: per-project test catalog + embedded-browser executor ----
  const testdir = require("../testing/testdir");
  handle("testdir:list", async (_e, cwd, filter) => testdir.list(cwd, filter || {}));
  handle("testdir:get", async (_e, cwd, id) => testdir.get(cwd, id));
  handle("testdir:upsert", async (_e, cwd, t, opts) => testdir.upsert(cwd, t || {}, opts || {}));
  handle("testdir:remove", async (_e, cwd, id) => testdir.remove(cwd, id));
  handle("testdir:retag", async (_e, cwd, id, patch) => testdir.retag(cwd, id, patch || {}));
  handle("testdir:select", async (_e, cwd, sel) => testdir.select(cwd, sel || {}));
  handle("testdir:run", async (_e, cwd, id, opts) => testdir.runTest(cwd, id, opts || {}));
  handle("testdir:run-selection", async (_e, cwd, sel, opts) => testdir.runSelection(cwd, sel || {}, opts || {}));
  handle("testdir:flake-gate", async (_e, cwd, ids, n) => testdir.flakeGate(cwd, ids || [], n || 3));
  handle("testdir:peek", async (_e, cwd) => testdir.peek(cwd));
  handle("testdir:classify", async (_e, source) => testdir.classifyByImports(source || ""));
  handle("testdir:integrity", async (_e, oldT, newT) => testdir.checkIntegrity(oldT || {}, newT || {}));
  handle("testdir:goal-create", async (_e, cwd, g) => testdir.createGoal(cwd, g || {}));
  handle("testdir:goal-update", async (_e, cwd, id, patch) => testdir.updateGoal(cwd, id, patch || {}));
  handle("testdir:goal-approve", async (_e, cwd, id) => testdir.approveGoal(cwd, id));
  handle("testdir:goal-attach", async (_e, cwd, gid, tid) => testdir.attachTest(cwd, gid, tid));
  handle("testdir:goals", async (_e, cwd) => testdir.listGoals(cwd));
  handle("testdir:goal-green", async (_e, cwd, id) => testdir.goalGreen(cwd, id));
  handle("testhost:run", async (_e, target, steps) => require("../testing/testhost").runSteps(target, steps, { now: Date.now }));

  // ---- Test Director Phase 2: goal → GREEN orchestrator ----
  const director = require("../testing/director");
  handle("director:plan", async (_e, cwd, prompt, opts) => director.plan(cwd, prompt, opts || {}));
  handle("director:approve", async (_e, cwd, goalId) => director.approve(cwd, goalId));
  handle("director:run", async (_e, cwd, goalId, opts) => director.runGoal(cwd, goalId, opts || {}));
}

module.exports = { register };
