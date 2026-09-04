/// <reference types="jest" />

import {
  clearDiscoverCache,
  discoverModels,
  getAllModels,
} from "../src/discover";

function response(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

describe("model discovery", () => {
  beforeEach(() => {
    clearDiscoverCache();
    global.fetch = jest.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/zen/go/v1/models")) {
        return Promise.resolve(
          response({ data: [{ id: "glm-5" }, { id: "future-model" }] })
        );
      }
      if (url.endsWith("/zen/v1/models")) {
        return Promise.resolve(response({ data: [] }));
      }
      return Promise.resolve(
        response({
          "opencode-go": {
            models: {
              "glm-5": { limit: { context: 202752, output: 32768 } },
              "future-model": {
                limit: { context: 1000000, input: 900000, output: 65536 },
              },
            },
          },
        })
      );
    }) as unknown as typeof fetch;
  });

  it("applies models.dev limits to known and newly discovered models", async () => {
    const discovered = await discoverModels();
    const models = getAllModels(discovered);

    const glm5 = models.find((model) => model.id === "glm-5");
    expect(glm5).toMatchObject({
      contextWindow: 202752,
      maxOutput: 32768,
    });

    const future = models.find((model) => model.id === "future-model");
    expect(future).toMatchObject({
      contextWindow: 1000000,
      inputLimit: 900000,
      maxOutput: 65536,
    });
  });

  it("falls back when models.dev does not provide valid limits", async () => {
    (global.fetch as jest.Mock).mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url.includes("models.dev")) {
        return Promise.resolve(
          response({ "opencode-go": { models: { "future-model": {} } } })
        );
      }
      if (url.endsWith("/zen/go/v1/models")) {
        return Promise.resolve(response({ data: [{ id: "future-model" }] }));
      }
      return Promise.resolve(response({ data: [] }));
    });

    const [future] = await discoverModels();
    expect(future).toMatchObject({
      contextWindow: 131072,
      maxOutput: 65536,
    });
  });
});
