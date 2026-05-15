/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 5

declare module "vscode" {
  /**
   * The provider version of {@linkcode LanguageModelChatRequestOptions}
   */
  export interface ProvideLanguageModelChatResponseOptions {
    /**
     * What extension initiated the request to the language model, or
     * `undefined` if the request was initiated by other functionality in the editor.
     */
    readonly requestInitiator: string;

    /**
     * Per-model configuration provided by the user. This contains values configured
     * in the user's language models configuration file, validated against the model's
     * {@linkcode LanguageModelChatInformation.configurationSchema configurationSchema}.
     */
    readonly modelConfiguration?: {
      readonly [key: string]: any;
    };
  }

  /**
   * All the information representing a single language model contributed by a {@linkcode LanguageModelChatProvider}.
   */
  export interface LanguageModelChatInformation {
    /**
     * When present, this gates the use of `requestLanguageModelAccess` behind an authorization flow where
     * the user must approve of another extension accessing the models contributed by this extension.
     */
    requiresAuthorization?: true | { label: string };

    /**
     * A numeric value for comparing model cost tiers.
     */
    readonly multiplierNumeric?: number;

    /**
     * Whether or not this will be selected by default in the model picker.
     * NOT BEING FINALIZED
     */
    readonly isDefault?: boolean | { [K in ChatLocation]?: boolean };

    /**
     * Whether or not the model will show up in the model picker immediately upon being made known.
     * NOT BEING FINALIZED
     */
    readonly isUserSelectable?: boolean;

    readonly statusIcon?: ThemeIcon;

    /**
     * An optional JSON schema describing the configuration options for this model.
     * When set, users can specify per-model configuration in their language models
     * configuration file. The configured values are merged into the request options
     * when sending chat requests to this model.
     */
    readonly configurationSchema?: LanguageModelConfigurationSchema;

    /**
     * When set, this model is only shown in the model picker for the specified chat session type.
     */
    readonly targetChatSessionType?: string;
  }

  export interface LanguageModelChatCapabilities {
    /**
     * The tools the model prefers for making file edits.
     */
    readonly editTools?: string[];
  }

  /**
   * Native VS Code thinking/reasoning part (VS Code 1.120+).
   * Providers should use this for streaming reasoning content so VS Code can
   * display it natively in the thinking UI instead of hiding it in a data part.
   */
  export class LanguageModelThinkingPart {
    /**
     * The thinking content text.
     */
    readonly value: string;
    constructor(value: string);
  }

  export type LanguageModelResponsePart2 =
    | LanguageModelResponsePart
    | LanguageModelDataPart
    | LanguageModelThinkingPart;

  /**
   * A [JSON Schema](https://json-schema.org) describing configuration options for a language model.
   */
  export type LanguageModelConfigurationSchema = {
    readonly properties?: {
      readonly [key: string]: Record<string, any> & {
        /**
         * Human-readable labels for enum values, shown instead of the raw values.
         * Must have the same length and order as `enum`.
         */
        readonly enumItemLabels?: string[];
        /**
         * The group this property belongs to. When set to `'navigation'`, the property
         * is shown as a primary action in the model picker.
         */
        readonly group?: string;
      };
    };
  };

  export interface LanguageModelChatProvider<
    T extends LanguageModelChatInformation = LanguageModelChatInformation,
  > {
    provideLanguageModelChatInformation(
      options: PrepareLanguageModelChatModelOptions,
      token: CancellationToken
    ): ProviderResult<T[]>;
    provideLanguageModelChatResponse(
      model: T,
      messages: readonly LanguageModelChatRequestMessage[],
      options: ProvideLanguageModelChatResponseOptions,
      progress: Progress<LanguageModelResponsePart2>,
      token: CancellationToken
    ): Thenable<void>;
  }

  /**
   * The list of options passed into {@linkcode LanguageModelChatProvider.provideLanguageModelChatInformation}
   */
  export interface PrepareLanguageModelChatModelOptions {
    /**
     * Configuration for the model. Only present if the provider declared it requires configuration.
     */
    readonly configuration?: {
      readonly [key: string]: any;
    };
  }

  export interface ChatRequest {
    /**
     * Per-model configuration provided by the user, resolved from the model's configurationSchema.
     */
    readonly modelConfiguration?: { readonly [key: string]: any };
  }
}
