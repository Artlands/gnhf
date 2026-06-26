import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  writeTierPlan,
  readTierPlan,
  deleteTierPlan,
} from "./run.js";

describe("tierPlan persistence", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gnhf-tierplan-test-"));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writeTierPlan writes a valid JSON file", () => {
    const planPath = join(tmpDir, "tier-plan.json");
    writeTierPlan(planPath, {
      tiers: ["complex", "simple"],
      plan: ["initial design", "implement"],
      rationale: "start complex, then simple",
      consumed: 0,
    });
    const raw = readFileSync(planPath, "utf-8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.tiers).toEqual(["complex", "simple"]);
    expect(parsed.plan).toEqual(["initial design", "implement"]);
    expect(parsed.rationale).toBe("start complex, then simple");
    expect(parsed.consumed).toBe(0);
  });

  it("readTierPlan reads back a valid plan", () => {
    const planPath = join(tmpDir, "tier-plan-2.json");
    writeTierPlan(planPath, {
      tiers: ["simple"],
      plan: ["fix typo"],
      rationale: "trivial change",
      consumed: 0,
    });
    const loaded = readTierPlan(planPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.tiers).toEqual(["simple"]);
    expect(loaded!.plan).toEqual(["fix typo"]);
    expect(loaded!.consumed).toBe(0);
  });

  it("readTierPlan returns null when the file does not exist", () => {
    const loaded = readTierPlan(join(tmpDir, "nonexistent.json"));
    expect(loaded).toBeNull();
  });

  it("readTierPlan returns null when the file contains invalid JSON", () => {
    const planPath = join(tmpDir, "bad-plan.json");
    writeFileSync(planPath, "not json", "utf-8");
    const loaded = readTierPlan(planPath);
    expect(loaded).toBeNull();
  });

  it("readTierPlan returns null for an empty file", () => {
    const planPath = join(tmpDir, "empty-plan.json");
    writeFileSync(planPath, "", "utf-8");
    const loaded = readTierPlan(planPath);
    expect(loaded).toBeNull();
  });

  it("deleteTierPlan removes the file", () => {
    const planPath = join(tmpDir, "to-delete.json");
    writeTierPlan(planPath, {
      tiers: ["complex"],
      plan: ["plan"],
      rationale: "r",
      consumed: 0,
    });
    expect(existsSync(planPath)).toBe(true);
    deleteTierPlan(planPath);
    expect(existsSync(planPath)).toBe(false);
  });

  it("deleteTierPlan does not throw when the file does not exist", () => {
    expect(() =>
      deleteTierPlan(join(tmpDir, "never-existed.json")),
    ).not.toThrow();
  });
});
