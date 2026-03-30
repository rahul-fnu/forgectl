import { EventEmitter } from "node:events";

export class PipelineValidationError extends Error {
  details: string[];

  constructor(message: string, details: string[]) {
    super(message);
    this.name = "PipelineValidationError";
    this.details = details;
  }
}

/**
 * Stub PipelineRunService — pipeline engine has been removed.
 * Keeps the interface so routes and board engine compile.
 */
export class PipelineRunService extends EventEmitter {
  constructor(_repo?: unknown) {
    super();
  }

  submitPipeline(_pipeline: unknown, _options?: unknown): never {
    throw new PipelineValidationError("Pipeline engine has been removed", []);
  }

  rerunPipeline(_baseRunId: string, _options: unknown): never {
    throw new Error("Pipeline engine has been removed");
  }

  listRuns(): never[] {
    return [];
  }

  getRun(_id: string): null {
    return null;
  }

  async waitFor(_runId: string): Promise<never> {
    throw new Error("Pipeline engine has been removed");
  }
}
