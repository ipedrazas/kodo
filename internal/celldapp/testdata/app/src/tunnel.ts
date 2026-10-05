import { connect } from "cloudflare:sockets";

export class Tunnel {
  async fetch(): Promise<Response> {
    const socket = connect("example.com:80");
    await socket.close();
    return new Response("connected");
  }
}
