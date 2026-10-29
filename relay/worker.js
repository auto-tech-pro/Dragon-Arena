// Dragon Arena relay: pairs two players by room code and passes their messages along.
// Runs on Cloudflare Workers + one Durable Object per room. Nothing is stored.
export class Room {
  constructor(state) { this.state = state; }
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Dragon Arena relay: expected a WebSocket', { status: 426 });
    const role = new URL(request.url).searchParams.get('role') === 'host' ? 'host' : 'guest';
    const socks = this.state.getWebSockets();
    const has = r => socks.some(s => this.state.getTags(s).includes(r));
    if (role === 'guest' && !has('host')) return new Response('no such room', { status: 404 });
    if (has(role)) return new Response(role === 'host' ? 'room code in use' : 'room is full', { status: 409 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [role]);
    if (role === 'guest') {
      server.send('{"t":"peer"}');
      socks.forEach(s => s.send('{"t":"peer"}'));
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, msg) {
    for (const s of this.state.getWebSockets()) if (s !== ws) { try { s.send(msg); } catch (e) {} }
  }
  webSocketClose(ws, code) {
    try { ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, 'closing'); } catch (e) {}
    for (const s of this.state.getWebSockets()) if (s !== ws) { try { s.send('{"t":"bye"}'); } catch (e) {} }
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011); }
}
export default {
  async fetch(request, env) {
    const room = (new URL(request.url).searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!room) return new Response('Dragon Arena relay is running.');
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
  }
};
