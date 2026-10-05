export class Secret {
  constructor(
    _state: DurableObjectState,
    private readonly env: { API_KEY: string; LOADER: unknown },
  ) {}

  async fetch(): Promise<Response> {
    return new Response(this.env.API_KEY + String(this.env.LOADER));
  }
}
