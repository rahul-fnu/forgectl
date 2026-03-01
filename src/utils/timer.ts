export class Timer {
  private startTime: number;
  constructor() { this.startTime = Date.now(); }
  elapsed(): number { return Date.now() - this.startTime; }
  reset(): void { this.startTime = Date.now(); }
}
