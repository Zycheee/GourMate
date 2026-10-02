/** One reply owns captions and speech; superseded replies cannot resume (§7). */
export class ReplyGate {
  private active: string | null = null;
  private cancelled = new Set<string>();

  cancel(): void {
    if (this.active) this.reject(this.active);
    this.active = null;
  }

  private reject(id: string): void {
    this.cancelled.add(id);
    if (this.cancelled.size > 64) this.cancelled.delete(this.cancelled.values().next().value!);
  }

  accept(id: string | undefined, startsReply: boolean): "ignore" | "start" | "continue" {
    if (!id) return "continue"; // Legacy serializers remain compatible.
    if (this.cancelled.has(id)) return "ignore";
    if (id === this.active) return "continue";
    if (!startsReply) return "ignore";
    if (this.active) this.reject(this.active);
    this.active = id;
    return "start";
  }
}
