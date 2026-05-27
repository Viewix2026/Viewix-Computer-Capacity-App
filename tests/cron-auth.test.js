// tests/cron-auth.test.js
// Unit tests for api/_cronAuth.js — the cron authentication boundary.
// The headline case (Codex security audit, 2026-05-27): a forged
// `x-vercel-cron` header must NOT authenticate when CRON_SECRET is set.

import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedCron } from "../api/_cronAuth.js";

// _cronAuth reads process.env at call time, so set/restore per test.
function withEnv(env, fn) {
  const saved = {};
  for (const k of ["CRON_SECRET", "CRON_TEST_SECRET"]) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return fn(); }
  finally {
    for (const k of ["CRON_SECRET", "CRON_TEST_SECRET"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── The security case ──────────────────────────────────────────────
test("forged x-vercel-cron is REJECTED when CRON_SECRET is set", () => {
  withEnv({ CRON_SECRET: "s3cr3t" }, () => {
    const res = isAuthorizedCron({ headers: { "x-vercel-cron": "1" } });
    assert.equal(res.ok, false);
  });
});

test("forged x-vercel-cron with arbitrary value also rejected (CRON_SECRET set)", () => {
  withEnv({ CRON_SECRET: "s3cr3t" }, () => {
    const res = isAuthorizedCron({ headers: { "x-vercel-cron": "anything" } });
    assert.equal(res.ok, false);
  });
});

// ── Bearer (the real cron path) ────────────────────────────────────
test("valid Bearer CRON_SECRET authenticates", () => {
  withEnv({ CRON_SECRET: "s3cr3t" }, () => {
    const res = isAuthorizedCron({ headers: { authorization: "Bearer s3cr3t" } });
    assert.equal(res.ok, true);
    assert.equal(res.via, "cron_secret");
    assert.equal(res.secretValid, false);
  });
});

test("wrong Bearer is rejected", () => {
  withEnv({ CRON_SECRET: "s3cr3t" }, () => {
    const res = isAuthorizedCron({ headers: { authorization: "Bearer nope" } });
    assert.equal(res.ok, false);
  });
});

// ── Manual test secret ─────────────────────────────────────────────
test("valid ?secret=CRON_TEST_SECRET authenticates with secretValid", () => {
  withEnv({ CRON_SECRET: "s3cr3t", CRON_TEST_SECRET: "testsec" }, () => {
    const res = isAuthorizedCron({ headers: {}, url: "/api/x?secret=testsec" });
    assert.equal(res.ok, true);
    assert.equal(res.via, "test_secret");
    assert.equal(res.secretValid, true);
  });
});

// ── Legacy fallback ONLY when CRON_SECRET unset ────────────────────
test("x-vercel-cron allowed as fallback ONLY when CRON_SECRET is unset", () => {
  withEnv({ CRON_SECRET: undefined }, () => {
    const res = isAuthorizedCron({ headers: { "x-vercel-cron": "1" } });
    assert.equal(res.ok, true);
    assert.equal(res.via, "vercel_cron_header");
  });
});

// ── Nothing at all ─────────────────────────────────────────────────
test("no headers / no secret → rejected", () => {
  withEnv({ CRON_SECRET: "s3cr3t" }, () => {
    const res = isAuthorizedCron({ headers: {} });
    assert.equal(res.ok, false);
  });
});
