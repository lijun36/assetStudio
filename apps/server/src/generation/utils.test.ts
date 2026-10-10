import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAsBase64 } from "./utils.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchAsBase64", () => {
  it("keeps signed URL tokens out of fetch errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid signature", { status: 400 })));
    const error = await fetchAsBase64("google-vertex", "https://assets.example/image.png?token=private-signature").catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Failed to fetch input (HTTP 400)");
    expect((error as Error).message).not.toContain("private-signature");
  });
});
