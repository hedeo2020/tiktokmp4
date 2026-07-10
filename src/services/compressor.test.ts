import { describe, expect, it } from "vitest";
import {
  calculateEncodingSettings,
  chooseAdaptiveMaxHeight,
  MIB
} from "./compressor.js";

describe("calculateEncodingSettings", () => {
  it("calculates target size by 20 second blocks", () => {
    expect(calculateEncodingSettings(1, 1).targetBytes).toBe(MIB);
    expect(calculateEncodingSettings(40, 1).targetBytes).toBe(2 * MIB);
    expect(calculateEncodingSettings(60, 3).targetBytes).toBe(9 * MIB);
  });

  it("calculates a usable bitrate", () => {
    const settings = calculateEncodingSettings(60, 1);
    expect(settings.totalBitrateBps).toBeGreaterThan(120_000);
    expect(settings.videoBitrateBps).toBe(settings.totalBitrateBps - settings.audioBitrateBps);
  });
});

describe("chooseAdaptiveMaxHeight", () => {
  it("selects resolution bands from video bitrate", () => {
    expect(chooseAdaptiveMaxHeight(1_500_000)).toBe(1080);
    expect(chooseAdaptiveMaxHeight(900_000)).toBe(720);
    expect(chooseAdaptiveMaxHeight(500_000)).toBe(540);
    expect(chooseAdaptiveMaxHeight(250_000)).toBe(480);
    expect(chooseAdaptiveMaxHeight(249_000)).toBe(360);
  });
});
