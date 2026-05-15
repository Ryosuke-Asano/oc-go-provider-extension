import * as vscode from "vscode";

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

  /**
   * Analyze an image using a configurable OpenCode Go vision model.
   * Used to give non-vision models a textual description of attached images.
   * @param imageData Base64-encoded image (data URL format)
   * @param prompt What to analyze in the image
   * @param proxyModelId Vision-capable model id to perform the analysis (defaults to "kimi-k2.6")
   * @returns Image analysis result
   */
  async analyzeImage(
    imageData: string,
    prompt: string,
    proxyModelId: string = "kimi-k2.6"
  ): Promise<string> {
    if (!(await this.ensureApiKey())) {
      throw new Error("OpenCode Go API key not found");
    }

    const startedAt = Date.now();
    console.log("[OpenCode Go MCP] analyzeImage: calling proxy", {
      proxyModelId,
      promptLength: prompt.length,
      imageDataLength: imageData.length,
    });

    let response: Response;
    try {
      response = await fetch(
        "https://opencode.ai/zen/go/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: proxyModelId,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: imageData } },
                ],
              },
            ],
            max_tokens: 2000,
          }),
        }
      );
    } catch (err) {
      console.error("[OpenCode Go MCP] analyzeImage: fetch failed", {
        proxyModelId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[OpenCode Go MCP] analyzeImage: HTTP error", {
        proxyModelId,
        status: response.status,
        statusText: response.statusText,
        body: errorText.slice(0, 500),
      });
      throw new Error(`Vision API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };

    const result =
      data.choices?.[0]?.message?.content ?? "Failed to analyze image";
    console.log("[OpenCode Go MCP] analyzeImage: proxy response", {
      proxyModelId,
      resultLength: result.length,
      preview: result.slice(0, 200),
      durationMs: Date.now() - startedAt,
      usage: data.usage,
    });
    return result;
  }
}
