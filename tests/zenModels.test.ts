/// <reference types="jest" />

import { clearZenModelCache, fetchZenModels } from "../src/zenModels";

function mockModelsResponse(models: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      opencode: {
        id: "opencode",
        name: "OpenCode",
        npm: "openai",
        api: "openai",
        models,
      },
    }),
  };
}

describe("zenModels cache", () => {
  beforeEach(() => {
    clearZenModelCache();
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it("should reuse the cached Zen model list for the same API key", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue(
      mockModelsResponse({
        "big-pickle": { id: "big-pickle", name: "Big Pickle" },
      }) as never
    );

    const first = await fetchZenModels("same-key");
    const second = await fetchZenModels("same-key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.map((m) => m.id)).toContain("big-pickle");
  });

  it("should not reuse the cached Zen model list across different API keys", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(
        mockModelsResponse({
          "big-pickle": { id: "big-pickle", name: "Big Pickle" },
        }) as never
      )
      .mockResolvedValueOnce(
        mockModelsResponse({
          "nemotron-3-super-free": {
            id: "nemotron-3-super-free",
            name: "Nemotron 3 Super Free",
          },
        }) as never
      );

    const first = await fetchZenModels("first-key");
    const second = await fetchZenModels("second-key");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.map((m) => m.id)).toContain("big-pickle");
    expect(second.map((m) => m.id)).toContain("nemotron-3-super-free");
    expect(second.map((m) => m.id)).not.toContain("big-pickle");
  });
});
