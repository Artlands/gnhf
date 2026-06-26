import { describe, expect, it } from "vitest";
import { buildAgentOutputSchema } from "./types.js";

describe("buildAgentOutputSchema", () => {
  it("adds configured commit message fields to properties and required", () => {
    const schema = buildAgentOutputSchema({
      includeStopField: false,
      commitFields: [
        {
          name: "type",
          allowed: ["feat", "fix"],
        },
        {
          name: "scope",
        },
      ],
    });

    expect(schema.properties.type).toEqual({
      type: "string",
      enum: ["feat", "fix"],
    });
    expect(schema.properties.scope).toEqual({ type: "string" });
    expect(schema.required).toContain("type");
    expect(schema.required).toContain("scope");
  });

  it("adds the tier field with an enum of allowed values when set", () => {
    const schema = buildAgentOutputSchema({
      includeStopField: false,
      tierField: {
        name: "next_iteration_tier",
        allowed: ["complex", "simple", "cheap"],
      },
    });

    expect(schema.properties.next_iteration_tier).toEqual({
      type: "string",
      enum: ["complex", "simple", "cheap"],
    });
    expect(schema.required).toContain("next_iteration_tier");
  });

  it("includes both should_fully_stop and next_iteration_tier when both are configured", () => {
    const schema = buildAgentOutputSchema({
      includeStopField: true,
      tierField: {
        name: "next_iteration_tier",
        allowed: ["complex", "simple"],
      },
    });

    expect(schema.properties.should_fully_stop).toEqual({ type: "boolean" });
    expect(schema.properties.next_iteration_tier).toEqual({
      type: "string",
      enum: ["complex", "simple"],
    });
    expect(schema.required).toContain("should_fully_stop");
    expect(schema.required).toContain("next_iteration_tier");
  });

  it("omits the tier field when not configured", () => {
    const schema = buildAgentOutputSchema({ includeStopField: false });
    expect(schema.properties.next_iteration_tier).toBeUndefined();
    expect(schema.required).not.toContain("next_iteration_tier");
  });
});
