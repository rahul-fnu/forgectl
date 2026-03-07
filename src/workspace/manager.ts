import path from "node:path";
import os from "node:os";
import { mkdir, rm, stat, readdir } from "node:fs/promises";
import { sanitizeIdentifier, assertContainment } from "./safety.js";
import { executeHook } from "./hooks.js";
import { parseDuration } from "../utils/duration.js";
import type { Logger } from "../logging/logger.js";

export interface WorkspaceInfo {
  path: string;
  identifier: string;
  created: boolean;
}

interface WorkspaceConfig {
  root: string;
  hooks: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
  };
  hook_timeout: string;
}

export class WorkspaceManager {
  private readonly root: string;
  private readonly hooks: WorkspaceConfig["hooks"];
  private readonly hookTimeoutMs: number;
  private readonly logger: Logger;

  constructor(config: WorkspaceConfig, logger: Logger) {
    this.root = config.root.startsWith("~")
      ? path.join(os.homedir(), config.root.slice(1))
      : config.root;
    this.hooks = config.hooks;
    this.hookTimeoutMs = parseDuration(config.hook_timeout);
    this.logger = logger;
  }

  async ensureWorkspace(identifier: string): Promise<WorkspaceInfo> {
    const sanitized = sanitizeIdentifier(identifier);
    const wsPath = path.join(this.root, sanitized);
    assertContainment(this.root, wsPath);

    let created = false;
    try {
      await stat(wsPath);
      // Directory exists -- reuse
    } catch (err: any) {
      if (err.code === "ENOENT") {
        await mkdir(wsPath, { recursive: true });
        created = true;
      } else {
        throw err;
      }
    }

    if (created && this.hooks.after_create) {
      await executeHook("after_create", this.hooks.after_create, wsPath, this.hookTimeoutMs);
    }

    this.logger.debug("workspace", `ensureWorkspace: ${sanitized} (created=${created})`, {
      path: wsPath,
    });

    return { path: wsPath, identifier: sanitized, created };
  }

  async runBeforeHook(identifier: string): Promise<void> {
    if (!this.hooks.before_run) return;
    const sanitized = sanitizeIdentifier(identifier);
    const wsPath = path.join(this.root, sanitized);
    assertContainment(this.root, wsPath);
    await executeHook("before_run", this.hooks.before_run, wsPath, this.hookTimeoutMs);
  }

  async runAfterHook(identifier: string): Promise<void> {
    if (!this.hooks.after_run) return;
    const sanitized = sanitizeIdentifier(identifier);
    const wsPath = path.join(this.root, sanitized);
    assertContainment(this.root, wsPath);
    try {
      await executeHook("after_run", this.hooks.after_run, wsPath, this.hookTimeoutMs);
    } catch (err: any) {
      this.logger.warn("workspace", `after_run hook failed (ignored): ${err.message}`, {
        identifier: sanitized,
      });
    }
  }

  async removeWorkspace(identifier: string): Promise<void> {
    const sanitized = sanitizeIdentifier(identifier);
    const wsPath = path.join(this.root, sanitized);
    assertContainment(this.root, wsPath);

    if (this.hooks.before_remove) {
      try {
        await executeHook("before_remove", this.hooks.before_remove, wsPath, this.hookTimeoutMs);
      } catch (err: any) {
        this.logger.warn("workspace", `before_remove hook failed (ignored): ${err.message}`, {
          identifier: sanitized,
        });
      }
    }

    this.logger.info("workspace", `Removing workspace: ${sanitized}`, { path: wsPath });
    await rm(wsPath, { recursive: true, force: true });
  }

  async cleanupTerminalWorkspaces(terminalIdentifiers: string[]): Promise<void> {
    const terminalSet = new Set(
      terminalIdentifiers.map((id) => sanitizeIdentifier(id)),
    );

    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (err: any) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      if (terminalSet.has(entry)) {
        await this.removeWorkspace(entry);
      }
    }
  }

  getWorkspacePath(identifier: string): string {
    const sanitized = sanitizeIdentifier(identifier);
    const wsPath = path.join(this.root, sanitized);
    assertContainment(this.root, wsPath);
    return wsPath;
  }
}
