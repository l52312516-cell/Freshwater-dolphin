'use strict';

const { fail } = require('./files.cjs');

// One bounded publisher serves all management tabs. Expensive log reads and
// serialization happen once per tick, rather than once for every browser tab.
class ManagementEvents {
    constructor({ overview, readLogs, auth, now = Date.now, intervalMs = 2000,
        maxStreams = 16, perSession = 4, maxBufferedBytes = 512 * 1024 }) {
        Object.assign(this, { overview, readLogs, auth, now, intervalMs, maxStreams, perSession, maxBufferedBytes });
        this.clients = new Map(); this.timer = null; this.closed = false;
    }
    open(stream, session) {
        if (this.closed) throw fail('CLOSING', 'Management service is stopping', 503);
        if (this.clients.size >= this.maxStreams || [...this.clients.values()].filter(item => item.session === session).length >= this.perSession) {
            throw fail('STREAM_LIMIT', 'Close another management event stream before opening a new one', 429);
        }
        // Compute before committing SSE headers, so failures stay valid JSON errors.
        const snapshot = JSON.stringify(this.overview());
        const client = { stream, session, blocked: false, lastLog: '' };
        client.drain = () => { client.blocked = false; };
        client.close = () => {
            stream.removeListener('drain', client.drain); stream.removeListener('close', client.close);
            stream.removeListener('error', client.close);
            this.clients.delete(stream); session.streams.delete(stream);
            if (!this.clients.size) { clearInterval(this.timer); this.timer = null; }
        };
        stream.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
        this.clients.set(stream, client); session.streams.add(stream);
        stream.on('drain', client.drain); stream.once('close', client.close); stream.once('error', client.close);
        this.send(client, 'snapshot', snapshot);
        if (this.clients.size && !this.timer) {
            this.timer = setInterval(() => this.tick(), this.intervalMs); this.timer.unref?.();
        }
    }
    stop(client) {
        // Detach even when a broken transport throws or never emits close.
        client.close();
        try { client.stream.end(); } catch { try { client.stream.destroy?.(); } catch {} }
    }
    send(client, type, encoded) {
        const stream = client.stream;
        const frame = 'event: ' + type + '\ndata: ' + encoded + '\n\n';
        if (stream.destroyed || stream.writableEnded || client.blocked ||
            (stream.writableLength || 0) + Buffer.byteLength(frame) > this.maxBufferedBytes) {
            this.stop(client); return;
        }
        try { client.blocked = !stream.write(frame); }
        catch { this.stop(client); }
    }
    tick() {
        for (const client of this.clients.values()) if (client.session.expires <= this.now() || !this.auth.sessions.has(client.session.id)) this.stop(client);
        if (!this.clients.size) return;
        try {
            const snapshot = JSON.stringify(this.overview()), logs = JSON.stringify(this.readLogs());
            for (const client of this.clients.values()) {
                this.send(client, 'snapshot', snapshot);
                if (this.clients.has(client.stream) && client.lastLog !== logs) {
                    client.lastLog = logs; this.send(client, 'logs', logs);
                }
            }
        } catch {
            // A read failure must neither crash the manager nor leave a stale
            // dashboard connected. EventSource reconnects through normal auth.
            for (const client of this.clients.values()) this.stop(client);
        }
    }
    close() {
        this.closed = true; clearInterval(this.timer); this.timer = null;
        for (const client of this.clients.values()) this.stop(client);
    }
}

module.exports = { ManagementEvents };
