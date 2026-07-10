import { describe, expect, it } from "vitest";
import { validateTikTokUrl } from "./validation.js";

describe("validateTikTokUrl", () => {
  it("accepts supported HTTPS TikTok hosts", () => {
    expect(validateTikTokUrl("https://www.tiktok.com/@demo/video/123")).toBe(
      "https://www.tiktok.com/@demo/video/123"
    );
    expect(validateTikTokUrl("https://vm.tiktok.com/ZMabc/")).toBe("https://vm.tiktok.com/ZMabc/");
  });

  it("rejects unsupported hosts and protocols", () => {
    expect(() => validateTikTokUrl("http://www.tiktok.com/@demo/video/123")).toThrow();
    expect(() => validateTikTokUrl("https://example.com/video/123")).toThrow();
  });
});
