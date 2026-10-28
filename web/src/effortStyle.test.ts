import { expect, it } from "vitest";
import { effortBlurb, effortLook } from "./effortStyle";

it("makes low static and gives every step up more flourish", () => {
  const looks = ["low", "medium", "high", "xhigh", "max"].map((e, i) => effortLook(e, i, 5));
  expect(looks[0]).toMatchObject({ tier: 0, sparkles: 0 });
  expect(looks.map((l) => l.tier)).toEqual([0, 1, 2, 3, 4]);
  expect(looks[4]!.sparkles).toBeGreaterThan(looks[3]!.sparkles);
  expect(new Set(looks.map((l) => l.color)).size).toBe(5);
});

it("places an unknown Effort by its position among the levels", () => {
  expect(effortLook("turbo", 0, 3).tier).toBe(0);
  expect(effortLook("turbo", 2, 3).tier).toBe(5);
  expect(effortLook("turbo", 0, 1).tier).toBe(0);
});

it("knows a blurb for known Efforts only", () => {
  expect(effortBlurb("MAX")).toContain("sparingly");
  expect(effortBlurb("turbo")).toBe("");
});
