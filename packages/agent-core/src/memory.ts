import type { BrowserAction, Observation } from "@vibeqa/schemas";

export interface MemoryHistory {
  observations: readonly Observation[];
  actions: readonly BrowserAction[];
  discoveredBugs: readonly string[];
}

export class Memory {
  private readonly observations: Observation[] = [];
  private readonly actions: BrowserAction[] = [];
  private readonly discoveredBugs: string[] = [];

  addObservation(observation: Observation): void {
    this.observations.push(observation);
  }

  addAction(action: BrowserAction): void {
    this.actions.push(action);
  }

  addBug(description: string): void {
    if (!this.discoveredBugs.includes(description)) {
      this.discoveredBugs.push(description);
    }
  }

  getHistory(): MemoryHistory {
    return {
      observations: [...this.observations],
      actions: [...this.actions],
      discoveredBugs: [...this.discoveredBugs]
    };
  }

  clear(): void {
    this.observations.length = 0;
    this.actions.length = 0;
    this.discoveredBugs.length = 0;
  }
}
