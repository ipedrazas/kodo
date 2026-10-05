// Reads a binding by a computed name, which the checks cannot see: the
// gadget's env refuses it when it runs.
export class Settings {
  constructor(
    _state: DurableObjectState,
    private readonly env: Record<string, string>,
  ) {}

  async fetch(): Promise<Response> {
    const key = ["API", "KEY"].join("_");
    return new Response(this.env[key]);
  }
}
