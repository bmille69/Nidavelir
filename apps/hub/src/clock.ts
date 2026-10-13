export interface Clock {
  now(): string;
}

export const systemClock: Clock = { now: () => new Date().toISOString() };
