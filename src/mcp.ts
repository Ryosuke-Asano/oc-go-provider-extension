import * as vscode from "vscode";
import { DEFAULT_VISION_PROXY_MODEL } from "./types";
import { debugLog } from "./logging";

/**
 * OpenCode Go MCP Client for making HTTP-based MCP tool calls
 */
export class OcGoMcpClient {
  private apiKey: string;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.apiKey = "";
  }

  /**
   * Initialize the client with API key from secrets
   */
  private async ensureApiKey(): Promise<boolean> {
    if (!this.apiKey) {
      this.apiKey = (await this.secrets.get("opencode-go.apiKey")) ?? "";
    }
    return !!this.apiKey;
  }

  private getVisionProxyModel(proxyModelId?: string): string {
    if (proxyModelId) return proxyModelId;
    const configured = vscode.workspace
      .getConfiguration("opencodego")
      .get<string>("visionProxyModel", DEFAULT_VISION_PROXY_MODEL);
    return configured === "mimo-v2-omni"
      ? DEFAULT_VISION_PROXY_MODEL
      : configured;
  }

  /**
   * Analyze an image using the configured OpenCode Go Vision model.
   * This can be used for non-vision models to add image processing capabilities
   * @param imageData Base64-encoded image (data URL format)
   * @param prompt What to analyze in the image
   * @returns Image analysis result
   */
  async analyzeImage(
    imageData: string,
    prompt: string,
    proxyModelId?: string
  ): Promise<string> {
    if (!(await this.ensureApiKey())) {
      throw new Error("OpenCode Go API key not found");
    }

    const effectiveProxyModelId = this.getVisionProxyModel(proxyModelId);

    debugLog("OCR-CALL", {
      model: effectiveProxyModelId,
      imageDataLength: imageData.length,
      promptLength: prompt.length,
    });

    // Call Vision model via chat completions endpoint
    const response = await fetch(
      "https://opencode.ai/zen/go/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: effectiveProxyModelId,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageData } },
              ],
            },
          ],
          max_tokens: 16000,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vision API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const result =
      data.choices?.[0]?.message?.content ?? "Failed to analyze image";
    return result;
  }
}
