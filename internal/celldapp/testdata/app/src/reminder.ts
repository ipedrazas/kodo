export class Reminder {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    await this.state.storage.setAlarm(Date.now() + 60_000);
    return new Response("set");
  }

  async alarm(): Promise<void> {}
}
