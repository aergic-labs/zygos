/* eslint-disable @typescript-eslint/no-namespace */
/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Minimal `vscode` module stub for unit tests. Provides just enough of the
 * API surface for modules that import `vscode` at runtime.
 *
 * The config store is mutable so individual tests can set values via
 * `setConfig("section.key", value)`.
 */

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export interface Disposable {
  dispose(): void;
}

// --- Config store ---

const configStore: Record<string, unknown> = {};

/** Set a config value for testing. Key format: "section.key". */
export function setConfig(key: string, value: unknown): void {
  configStore[key] = value;
}

/** Reset all config values (call in beforeEach). */
export function resetConfig(): void {
  for (const key of Object.keys(configStore)) delete configStore[key];
}

class Configuration {
  private readonly prefix: string;
  constructor(section: string) {
    this.prefix = section + ".";
  }
  get<T>(key: string, defaultValue: T): T {
    const full = this.prefix + key;
    return (configStore[full] as T) ?? defaultValue;
  }
}

// --- Track registered label formatters & resolvers ---

export const registeredLabelFormatters: unknown[] = [];
export const registeredResolvers: Record<string, unknown> = {};

// --- Status bar items ---

export const createdStatusBarItems: Array<{
  text: string;
  tooltip: string;
  shown: boolean;
  disposed: boolean;
}> = [];

export function resetStatusBarItems(): void {
  createdStatusBarItems.length = 0;
}

// --- Commands ---

export const executedCommands: Array<{ command: string; args: unknown[] }> = [];

export function resetExecutedCommands(): void {
  executedCommands.length = 0;
}

export namespace commands {
  export function executeCommand(
    command: string,
    ...args: unknown[]
  ): Promise<unknown> {
    executedCommands.push({ command, args });
    return Promise.resolve(undefined);
  }
}

// --- Installed extensions ---

export interface MockExtension {
  id: string;
  extensionPath: string;
  packageJSON?: Record<string, unknown>;
}

export const installedExtensions: MockExtension[] = [];

export function resetInstalledExtensions(): void {
  installedExtensions.length = 0;
}

export namespace extensions {
  export function getExtension(id: string): MockExtension | undefined {
    return installedExtensions.find(
      (e) => e.id.toLowerCase() === id.toLowerCase(),
    );
  }
}

// --- Output channels ---

export const createdOutputChannels: Array<{
  name: string;
  lines: string[];
  shown: boolean;
  disposed: boolean;
}> = [];

export function resetOutputChannels(): void {
  createdOutputChannels.length = 0;
}

export function getOutputChannels(): typeof createdOutputChannels {
  return createdOutputChannels;
}

// --- Modal choice returned by showErrorMessage ---

export let nextErrorMessageChoice: string | undefined = undefined;

export function setNextErrorMessageChoice(v: string | undefined): void {
  nextErrorMessageChoice = v;
}

export namespace window {
  type WindowState = { focused: boolean };
  type StateListener = (state: WindowState) => void;

  export function onDidChangeWindowState(_listener: StateListener): Disposable {
    return { dispose: () => {} };
  }

  export function createOutputChannel(name: string): {
    appendLine(line: string): void;
    show(): void;
    dispose(): void;
  } {
    const ch = { name, lines: [] as string[], shown: false, disposed: false };
    createdOutputChannels.push(ch);
    return {
      appendLine(line: string) {
        ch.lines.push(line);
      },
      show() {
        ch.shown = true;
      },
      dispose() {
        ch.disposed = true;
      },
    };
  }

  export function createStatusBarItem(
    _alignment: StatusBarAlignment,
    _priority: number,
  ): {
    text: string;
    tooltip: string;
    show(): void;
    dispose(): void;
  } {
    const item = { text: "", tooltip: "", shown: false, disposed: false };
    createdStatusBarItems.push(item);
    return {
      get text() {
        return item.text;
      },
      set text(v: string) {
        item.text = v;
      },
      get tooltip() {
        return item.tooltip;
      },
      set tooltip(v: string) {
        item.tooltip = v;
      },
      show() {
        item.shown = true;
      },
      dispose() {
        item.disposed = true;
      },
    };
  }

  export async function showInputBox(_opts: {
    password?: boolean;
    prompt?: string;
    title?: string;
    ignoreFocusOut?: boolean;
  }): Promise<string | undefined> {
    return undefined;
  }

  export async function showErrorMessage(
    _message: string,
    ..._buttons: string[]
  ): Promise<string | undefined> {
    return nextErrorMessageChoice;
  }

  export async function showWarningMessage(
    _message: string,
    ..._buttons: string[]
  ): Promise<string | undefined> {
    return undefined;
  }
}

export const env: {
  remoteName: string | undefined;
  appRoot: string;
} = {
  remoteName: undefined,
  /** Set this in tests to point at a temp dir containing product.json. */
  appRoot: "/nonexistent",
};

export namespace workspace {
  export function getConfiguration(section: string): Configuration {
    return new Configuration(section);
  }

  export function registerResourceLabelFormatter(
    formatter: unknown,
  ): Disposable {
    registeredLabelFormatters.push(formatter);
    return { dispose: () => {} };
  }

  export function registerRemoteAuthorityResolver(
    scheme: string,
    resolver: unknown,
  ): Disposable {
    registeredResolvers[scheme] = resolver;
    return { dispose: () => {} };
  }
}
