/** Injectable time source so that expiry, SLA and billing logic is testable without sleeps. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class ManualClock implements Clock {
  private current: Date;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date | string): void {
    this.current = new Date(value);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
