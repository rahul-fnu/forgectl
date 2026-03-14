import { describe, it, expect } from "vitest";
import {
  TwoTierSlotManager,
  createTwoTierSlotManager,
} from "../../src/orchestrator/state.js";
import type { OrchestratorConfig } from "../../src/config/schema.js";
import { OrchestratorConfigSchema } from "../../src/config/schema.js";

// Helper to build a minimal WorkerInfo-like object (just needs to exist in the map)
function makeWorkerInfo(issueId: string) {
  return { issueId } as Parameters<TwoTierSlotManager["registerTopLevel"]>[1];
}

describe("TwoTierSlotManager", () => {
  describe("constructor and basic properties", () => {
    it("stores topLevelMax and childMax from constructor args", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      expect(mgr.availableTopLevelSlots()).toBe(3);
      expect(mgr.availableChildSlots()).toBe(2);
    });

    it("getMax() returns topLevelMax + childMax for backward compat", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      expect(mgr.getMax()).toBe(5);
    });

    it("getMax() works when childMax is 0", () => {
      const mgr = new TwoTierSlotManager(3, 0);
      expect(mgr.getMax()).toBe(3);
    });
  });

  describe("isDelegationEnabled()", () => {
    it("returns false when childMax is 0", () => {
      const mgr = new TwoTierSlotManager(3, 0);
      expect(mgr.isDelegationEnabled()).toBe(false);
    });

    it("returns true when childMax > 0", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      expect(mgr.isDelegationEnabled()).toBe(true);
    });
  });

  describe("hasTopLevelSlot()", () => {
    it("returns true when no top-level workers are running", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      expect(mgr.hasTopLevelSlot()).toBe(true);
    });

    it("returns false when top-level slots are full", () => {
      const mgr = new TwoTierSlotManager(2, 1);
      mgr.registerTopLevel("a", makeWorkerInfo("a"));
      mgr.registerTopLevel("b", makeWorkerInfo("b"));
      expect(mgr.hasTopLevelSlot()).toBe(false);
    });

    it("returns true after releasing a top-level slot", () => {
      const mgr = new TwoTierSlotManager(1, 0);
      mgr.registerTopLevel("a", makeWorkerInfo("a"));
      expect(mgr.hasTopLevelSlot()).toBe(false);
      mgr.releaseTopLevel("a");
      expect(mgr.hasTopLevelSlot()).toBe(true);
    });
  });

  describe("hasChildSlot()", () => {
    it("returns false when childMax is 0 (delegation disabled)", () => {
      const mgr = new TwoTierSlotManager(3, 0);
      expect(mgr.hasChildSlot()).toBe(false);
    });

    it("returns true when child slots are available", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      expect(mgr.hasChildSlot()).toBe(true);
    });

    it("returns false when child slots are full", () => {
      const mgr = new TwoTierSlotManager(3, 1);
      mgr.registerChild("c1", makeWorkerInfo("c1"));
      expect(mgr.hasChildSlot()).toBe(false);
    });

    it("returns true after releasing a child slot", () => {
      const mgr = new TwoTierSlotManager(3, 1);
      mgr.registerChild("c1", makeWorkerInfo("c1"));
      mgr.releaseChild("c1");
      expect(mgr.hasChildSlot()).toBe(true);
    });
  });

  describe("availableTopLevelSlots()", () => {
    it("returns topLevelMax when no workers running", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      expect(mgr.availableTopLevelSlots()).toBe(3);
    });

    it("decrements as workers are registered", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      mgr.registerTopLevel("a", makeWorkerInfo("a"));
      expect(mgr.availableTopLevelSlots()).toBe(2);
      mgr.registerTopLevel("b", makeWorkerInfo("b"));
      expect(mgr.availableTopLevelSlots()).toBe(1);
    });

    it("clamps to 0 when over-subscribed", () => {
      const mgr = new TwoTierSlotManager(1, 0);
      mgr.registerTopLevel("a", makeWorkerInfo("a"));
      mgr.registerTopLevel("b", makeWorkerInfo("b")); // over the limit
      expect(mgr.availableTopLevelSlots()).toBe(0);
    });
  });

  describe("availableChildSlots()", () => {
    it("returns childMax when no child workers running", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      expect(mgr.availableChildSlots()).toBe(2);
    });

    it("decrements as child workers are registered", () => {
      const mgr = new TwoTierSlotManager(3, 3);
      mgr.registerChild("c1", makeWorkerInfo("c1"));
      expect(mgr.availableChildSlots()).toBe(2);
    });

    it("clamps to 0 when over-subscribed", () => {
      const mgr = new TwoTierSlotManager(3, 1);
      mgr.registerChild("c1", makeWorkerInfo("c1"));
      mgr.registerChild("c2", makeWorkerInfo("c2")); // over the limit
      expect(mgr.availableChildSlots()).toBe(0);
    });

    it("returns 0 when childMax is 0", () => {
      const mgr = new TwoTierSlotManager(3, 0);
      expect(mgr.availableChildSlots()).toBe(0);
    });
  });

  describe("registerTopLevel / releaseTopLevel", () => {
    it("adds to topLevelRunning and removes on release", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      const info = makeWorkerInfo("issue-1");
      mgr.registerTopLevel("issue-1", info);
      expect(mgr.getTopLevelRunning().has("issue-1")).toBe(true);
      mgr.releaseTopLevel("issue-1");
      expect(mgr.getTopLevelRunning().has("issue-1")).toBe(false);
    });

    it("does not affect childRunning", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      mgr.registerTopLevel("issue-1", makeWorkerInfo("issue-1"));
      expect(mgr.getChildRunning().size).toBe(0);
    });
  });

  describe("registerChild / releaseChild", () => {
    it("adds to childRunning and removes on release", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      const info = makeWorkerInfo("child-1");
      mgr.registerChild("child-1", info);
      expect(mgr.getChildRunning().has("child-1")).toBe(true);
      mgr.releaseChild("child-1");
      expect(mgr.getChildRunning().has("child-1")).toBe(false);
    });

    it("does not affect topLevelRunning", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      mgr.registerChild("child-1", makeWorkerInfo("child-1"));
      expect(mgr.getTopLevelRunning().size).toBe(0);
    });
  });

  describe("top-level and child pools are independent", () => {
    it("filling child slots does not affect top-level availability", () => {
      const mgr = new TwoTierSlotManager(3, 2);
      mgr.registerChild("c1", makeWorkerInfo("c1"));
      mgr.registerChild("c2", makeWorkerInfo("c2"));
      expect(mgr.hasChildSlot()).toBe(false);
      expect(mgr.hasTopLevelSlot()).toBe(true);
      expect(mgr.availableTopLevelSlots()).toBe(3);
    });

    it("filling top-level slots does not affect child availability", () => {
      const mgr = new TwoTierSlotManager(2, 2);
      mgr.registerTopLevel("a", makeWorkerInfo("a"));
      mgr.registerTopLevel("b", makeWorkerInfo("b"));
      expect(mgr.hasTopLevelSlot()).toBe(false);
      expect(mgr.hasChildSlot()).toBe(true);
      expect(mgr.availableChildSlots()).toBe(2);
    });
  });
});

describe("createTwoTierSlotManager", () => {
  it("reads child_slots from OrchestratorConfig", () => {
    const config = OrchestratorConfigSchema.parse({
      child_slots: 2,
      max_concurrent_agents: 5,
    });
    const mgr = createTwoTierSlotManager(config);
    expect(mgr.availableChildSlots()).toBe(2);
    expect(mgr.availableTopLevelSlots()).toBe(3); // 5 - 2 = 3
  });

  it("computes topLevelMax = max_concurrent_agents - child_slots", () => {
    const config = OrchestratorConfigSchema.parse({
      max_concurrent_agents: 4,
      child_slots: 1,
    });
    const mgr = createTwoTierSlotManager(config);
    expect(mgr.availableTopLevelSlots()).toBe(3);
  });

  it("clamps topLevelMax to minimum 1 when child_slots >= max_concurrent_agents", () => {
    const config = OrchestratorConfigSchema.parse({
      max_concurrent_agents: 3,
      child_slots: 3,
    });
    const mgr = createTwoTierSlotManager(config);
    expect(mgr.availableTopLevelSlots()).toBe(1);
  });

  it("defaults child_slots to 0 when not specified", () => {
    const config = OrchestratorConfigSchema.parse({ max_concurrent_agents: 3 });
    const mgr = createTwoTierSlotManager(config);
    expect(mgr.availableChildSlots()).toBe(0);
    expect(mgr.availableTopLevelSlots()).toBe(3);
    expect(mgr.isDelegationEnabled()).toBe(false);
  });
});

describe("OrchestratorConfigSchema child_slots", () => {
  it("accepts child_slots field", () => {
    const result = OrchestratorConfigSchema.parse({ child_slots: 2 });
    expect(result.child_slots).toBe(2);
  });

  it("defaults child_slots to 0 when omitted", () => {
    const result = OrchestratorConfigSchema.parse({});
    expect(result.child_slots).toBe(0);
  });
});
