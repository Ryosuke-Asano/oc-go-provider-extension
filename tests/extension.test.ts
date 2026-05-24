/// <reference types="jest" />

import { refreshModelsForKeyChange } from "../src/extension";
import { fetchZenModels } from "../src/zenModels";
import { OC_GO_MODELS } from "../src/types";

jest.mock("../src/zenModels", () => ({
  fetchZenModels: jest.fn(),
}));

describe("refreshModelsForKeyChange", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should reset the Go provider to the static Go model catalog when the Go key changes", async () => {
    const goProvider = {
      updateModelList: jest.fn(),
      fireModelInfoChanged: jest.fn(),
    } as unknown as {
      updateModelList: jest.Mock;
      fireModelInfoChanged: jest.Mock;
    };
    const zenProvider = {
      updateModelList: jest.fn(),
      fireModelInfoChanged: jest.fn(),
    } as unknown as {
      updateModelList: jest.Mock;
      fireModelInfoChanged: jest.Mock;
    };

    await refreshModelsForKeyChange("opencode-go.apiKey", goProvider as any, zenProvider as any);

    expect(goProvider.updateModelList).toHaveBeenCalledWith(OC_GO_MODELS);
    expect(goProvider.fireModelInfoChanged).toHaveBeenCalledTimes(1);
    expect(fetchZenModels).not.toHaveBeenCalled();
    expect(zenProvider.updateModelList).not.toHaveBeenCalled();
  });

  it("should refresh only the Zen provider when the Zen key changes", async () => {
    const goProvider = {
      updateModelList: jest.fn(),
      fireModelInfoChanged: jest.fn(),
    } as unknown as {
      updateModelList: jest.Mock;
      fireModelInfoChanged: jest.Mock;
    };
    const zenProvider = {
      updateModelList: jest.fn(),
      fireModelInfoChanged: jest.fn(),
      getApiKeyForFetch: jest.fn().mockResolvedValue("zen-key"),
      getVendorLabel: jest.fn().mockReturnValue("OpenCode Zen"),
    } as unknown as {
      updateModelList: jest.Mock;
      fireModelInfoChanged: jest.Mock;
      getApiKeyForFetch: jest.Mock;
      getVendorLabel: jest.Mock;
    };

    (fetchZenModels as jest.Mock).mockResolvedValue([
      { id: "qwen3.6-plus-free" },
    ]);

    await refreshModelsForKeyChange("opencode-zen.apiKey", goProvider as any, zenProvider as any);

    expect(fetchZenModels).toHaveBeenCalledWith("zen-key");
    expect(zenProvider.updateModelList).toHaveBeenCalledWith([
      { id: "qwen3.6-plus-free" },
    ]);
    expect(zenProvider.fireModelInfoChanged).toHaveBeenCalledTimes(1);
    expect(goProvider.updateModelList).not.toHaveBeenCalled();
  });
});
