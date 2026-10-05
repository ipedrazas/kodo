// The Counter of celld-examples: a count in the object's storage.
export class Counter {
  constructor(
    private readonly state: DurableObjectState,
    _env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const value = (await this.state.storage.get<number>("value")) ?? 0;
      return Response.json({ value });
    }
    if (request.method === "POST") {
      const value = ((await this.state.storage.get<number>("value")) ?? 0) + 1;
      await this.state.storage.put("value", value);
      return Response.json({ value });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }
}
