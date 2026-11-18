// Ki Arena relay: rooms, quick match, ranked ladder. Runs on the Cloudflare Workers FREE plan.
// One Durable Object ("lobby") holds every connection. Match inputs are relayed, never simulated here.
import { DurableObject } from "cloudflare:workers";

const TIERS = [[1700,"Legend"],[1550,"Diamond"],[1400,"Platinum"],[1250,"Gold"],[1100,"Silver"],[0,"Bronze"]];
const tier = r => TIERS.find(t => r >= t[0])[1];
const FIDS = ["raiko","magnar","nyx","maru","brakk","sola","kuro","glacia"];
const clean = s => String(s || "").replace(/[^\w \-.!?]/g, "").trim().slice(0, 14) || "Fighter";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      return env.LOBBY.get(env.LOBBY.idFromName("lobby")).fetch(req);
    }
    return new Response("Ki Arena relay is running.", { headers: { "access-control-allow-origin": "*" } });
  }
};

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, name TEXT, rating INTEGER, w INTEGER, l INTEGER, ts INTEGER)`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({});
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---------- helpers
  att(ws) { return ws.deserializeAttachment() || {}; }
  set(ws, patch) { const a = Object.assign(this.att(ws), patch); ws.serializeAttachment(a); return a; }
  send(ws, o) { try { ws.send(typeof o === "string" ? o : JSON.stringify(o)); } catch (e) {} }
  all() { return this.ctx.getWebSockets(); }
  foeOf(ws, a) { if (!a.mid) return null; for (const o of this.all()) { if (o === ws) continue; const b = this.att(o); if (b.mid === a.mid) return o; } return null; }
  player(id, name) {
    let r = this.sql.exec(`SELECT * FROM players WHERE id=?`, id).toArray()[0];
    if (!r) { this.sql.exec(`INSERT INTO players VALUES(?,?,1000,0,0,?)`, id, name, Date.now()); r = { id, name, rating: 1000, w: 0, l: 0 }; }
    else if (name && r.name !== name) { this.sql.exec(`UPDATE players SET name=? WHERE id=?`, name, id); r.name = name; }
    return r;
  }
  me(a) { const r = this.player(a.id, a.name); return { rating: r.rating, w: r.w, l: r.l, tier: tier(r.rating) }; }

  start(x, y, mode) {
    const mid = crypto.randomUUID(), seed = (Math.random() * 2 ** 31) | 0;
    const A = this.att(x), B = this.att(y);
    const rx = mode === "ranked" ? this.player(A.id, A.name).rating : 0, ry = mode === "ranked" ? this.player(B.id, B.name).rating : 0;
    const base = { t: "match", mid, seed, mode, fids: [A.fid, B.fid], names: [A.name, B.name], ratings: [rx, ry] };
    this.set(x, { q: null, mid, side: 0, mode, res: null, rematch: false, foeId: B.id });
    this.set(y, { q: null, mid, side: 1, mode, res: null, rematch: false, foeId: A.id });
    this.send(x, { ...base, side: 0 });
    this.send(y, { ...base, side: 1 });
  }

  rate(winId, loseId) {
    const w = this.player(winId), l = this.player(loseId);
    const e = 1 / (1 + 10 ** ((l.rating - w.rating) / 400)), d = Math.max(4, Math.round(32 * (1 - e)));
    this.sql.exec(`UPDATE players SET rating=rating+?, w=w+1, ts=? WHERE id=?`, d, Date.now(), winId);
    this.sql.exec(`UPDATE players SET rating=MAX(0,rating-?), l=l+1, ts=? WHERE id=?`, d, Date.now(), loseId);
    return d;
  }
  tellRating(ws, delta) { const a = this.att(ws); if (a.id) this.send(ws, { t: "rated", delta, ...this.me(a) }); }

  // ---------- events
  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string") return;
    // Hot path: match input batches and sync snapshots are relayed untouched.
    const c = msg.charCodeAt(0);
    if (c === 73 /* I */ || c === 83 /* S */ || c === 72 /* H */) { const f = this.foeOf(ws, this.att(ws)); if (f) f.send(msg); return; }
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    let a = this.att(ws);
    switch (m.t) {
      case "hello": {
        const id = String(m.id || "").slice(0, 40); if (!id) return;
        a = this.set(ws, { id, name: clean(m.name) });
        this.send(ws, { t: "hi", ...this.me(a) });
        break;
      }
      case "queue": {
        if (!a.id || !FIDS.includes(m.fid)) return;
        const mode = m.mode === "ranked" ? "ranked" : "casual";
        if (a.mid) this.leave(ws);
        a = this.set(ws, { q: mode, fid: m.fid, room: null, since: Date.now(), mid: null });
        let best = null, bd = 1e9;
        const myR = mode === "ranked" ? this.player(a.id, a.name).rating : 0;
        for (const o of this.all()) {
          if (o === ws) continue; const b = this.att(o);
          if (b.q !== mode || b.id === a.id) continue;
          const d = mode === "ranked" ? Math.abs(this.player(b.id, b.name).rating - myR) : 0;
          if (d < bd) { bd = d; best = o; }
        }
        if (best) this.start(best, ws, mode); else this.send(ws, { t: "queued", mode });
        break;
      }
      case "room_create": {
        if (!a.id || !FIDS.includes(m.fid)) return;
        if (a.mid) this.leave(ws);
        const used = new Set(this.all().map(o => this.att(o).room));
        let code; do { code = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.random() * 32 | 0]).join(""); } while (used.has(code));
        this.set(ws, { q: "room", room: code, fid: m.fid, mid: null });
        this.send(ws, { t: "room", code });
        break;
      }
      case "room_join": {
        if (!a.id || !FIDS.includes(m.fid)) return;
        const code = String(m.code || "").toUpperCase().trim();
        const host = this.all().find(o => o !== ws && this.att(o).q === "room" && this.att(o).room === code);
        if (!host) { this.send(ws, { t: "err", msg: "No room with code " + code + ". Check the code with your friend." }); return; }
        this.set(ws, { fid: m.fid, room: code });
        this.start(host, ws, "room");
        break;
      }
      case "cancel": this.set(ws, { q: null, room: null }); break;
      case "result": {
        // Both players report. Ranked rating moves only when the two reports agree.
        if (!a.mid) return;
        a = this.set(ws, { res: m.winner === 0 || m.winner === 1 ? m.winner : -1 });
        const f = this.foeOf(ws, a); if (!f) return;
        const b = this.att(f);
        if (b.res == null) return;
        if (a.mode === "ranked") {
          if (a.res === b.res && a.res >= 0) {
            const winWs = a.side === a.res ? ws : f, loseWs = winWs === ws ? f : ws;
            const d = this.rate(this.att(winWs).id, this.att(loseWs).id);
            this.tellRating(winWs, d); this.tellRating(loseWs, -d);
          } else { this.send(ws, { t: "rated", delta: 0, note: "Results did not match, no rating change.", ...this.me(a) }); this.send(f, { t: "rated", delta: 0, note: "Results did not match, no rating change.", ...this.me(b) }); }
          this.set(ws, { mid: null, mode: null }); this.set(f, { mid: null, mode: null });
        }
        break;
      }
      case "rematch": {
        if (!a.mid || a.mode !== "room") return;
        if (FIDS.includes(m.fid)) a = this.set(ws, { fid: m.fid });
        a = this.set(ws, { rematch: true });
        const f = this.foeOf(ws, a); if (!f) { this.send(ws, { t: "foe_left" }); return; }
        if (this.att(f).rematch) { const host = a.side === 0 ? ws : f; this.start(host, host === ws ? f : ws, "room"); }
        else this.send(f, { t: "rematch_ask" });
        break;
      }
      case "leave": this.leave(ws); break;
      case "top": {
        const rows = this.sql.exec(`SELECT name, rating, w, l FROM players WHERE w+l>0 ORDER BY rating DESC, w DESC LIMIT 50`).toArray().map(r => ({ ...r, tier: tier(r.rating) }));
        let mine = null;
        if (a.id) { const r = this.player(a.id, a.name); const rank = this.sql.exec(`SELECT COUNT(*) AS n FROM players WHERE w+l>0 AND rating>?`, r.rating).one().n + 1; mine = { ...this.me(a), rank: r.w + r.l ? rank : null, name: r.name }; }
        this.send(ws, { t: "top", rows, me: mine });
        break;
      }
    }
  }

  leave(ws) {
    const a = this.att(ws);
    if (a.mid) {
      const f = this.foeOf(ws, a);
      if (f) {
        const b = this.att(f);
        // Leaving a ranked match before both results are in counts as a loss.
        if (a.mode === "ranked" && a.res == null) { const d = this.rate(b.id, a.id); this.tellRating(f, d); this.tellRating(ws, -d); }
        this.send(f, { t: "foe_left" });
        this.set(f, { mid: null, mode: null, rematch: false });
      }
    }
    this.set(ws, { mid: null, mode: null, q: null, room: null, rematch: false });
  }
  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }
}
