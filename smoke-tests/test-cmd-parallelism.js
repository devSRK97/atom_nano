/* Command parallelism: buildEnv() injects multi-core hints (MAKEFLAGS, CMAKE,
 * CARGO, npm, JOBS, UV_THREADPOOL) for the env Claude (and its spawned commands)
 * inherit — scaled by the user's setting, never overriding user-set values. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  await app.firstWindow();
  await new Promise((r) => setTimeout(r, 500));

  const cores = os.cpus().length;   // test runs on the same machine as the app
  const envFor = (mode) => app.evaluate((_e, m) => global.__claude.buildEnv({ commandParallelism: m }), mode);

  // off → no hints injected
  const off = await envFor("off");
  ok(!off.CMAKE_BUILD_PARALLEL_LEVEL && !off.CARGO_BUILD_JOBS, "off: no parallelism hints injected");

  // balanced → cores − 2 (min 1)
  const balN = String(Math.max(1, cores - 2));
  const bal = await envFor("balanced");
  ok(bal.CMAKE_BUILD_PARALLEL_LEVEL === balN, `balanced: CMAKE_BUILD_PARALLEL_LEVEL = ${bal.CMAKE_BUILD_PARALLEL_LEVEL} (cores-2 = ${balN})`);
  ok(/-j\d+/.test(bal.MAKEFLAGS || ""), `balanced: MAKEFLAGS has -j (${bal.MAKEFLAGS})`);
  ok(bal.CARGO_BUILD_JOBS === balN, `balanced: CARGO_BUILD_JOBS = ${bal.CARGO_BUILD_JOBS}`);
  ok(bal.npm_config_jobs === balN, `balanced: npm_config_jobs = ${bal.npm_config_jobs}`);
  ok(bal.JOBS === balN, `balanced: JOBS = ${bal.JOBS}`);
  ok(bal.UV_THREADPOOL_SIZE === balN, `balanced: UV_THREADPOOL_SIZE = ${bal.UV_THREADPOOL_SIZE}`);

  // max → all cores
  const maxN = String(Math.max(1, cores));
  const mx = await envFor("max");
  ok(mx.CMAKE_BUILD_PARALLEL_LEVEL === maxN, `max: CMAKE_BUILD_PARALLEL_LEVEL = ${mx.CMAKE_BUILD_PARALLEL_LEVEL} (all cores = ${maxN})`);
  ok(mx.MAKEFLAGS === `-j${maxN}`, `max: MAKEFLAGS = ${mx.MAKEFLAGS}`);

  // never overrides a value the user already set in their environment
  const overridden = await app.evaluate((_e) => {
    process.env.CMAKE_BUILD_PARALLEL_LEVEL = "3";
    const env = global.__claude.buildEnv({ commandParallelism: "max" });
    delete process.env.CMAKE_BUILD_PARALLEL_LEVEL;
    return env.CMAKE_BUILD_PARALLEL_LEVEL;
  });
  ok(overridden === "3", `respects a user-set value (kept CMAKE_BUILD_PARALLEL_LEVEL=${overridden}, didn't clobber)`);

  await app.close();
  console.log(process.exitCode ? "\nSOME PARALLELISM TESTS FAILED" : "\nALL PARALLELISM TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
