import type { RequestCounts } from "../types";

export type RequestType = keyof RequestCounts;

export class RequestBudget {
  private counts: RequestCounts = { amazon: 0, ebay: 0, image: 0, other: 0 };

  constructor(
    private softLimit: number,
    private onUpdate: (counts: RequestCounts) => void
  ) {}

  canMakeRequest(): boolean {
    return this.total() < this.softLimit;
  }

  consume(type: RequestType): void {
    this.counts[type]++;
    this.onUpdate({ ...this.counts });
  }

  total(): number {
    return (
      this.counts.amazon +
      this.counts.ebay +
      this.counts.image +
      this.counts.other
    );
  }

  getCounts(): RequestCounts {
    return { ...this.counts };
  }
}
