'use strict';

const STREAMED_ACTIONS = new Set(['upload_file_stream', 'download_file_stream', 'download_file_image_stream', 'download_file_record_stream', 'test_download_stream']);
const MAX_STREAM_FRAME = 1024 * 1024;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function frame(data, request) {
    const value = { status: 'ok', retcode: 0, data, message: '', wording: '', stream: 'stream-action',
        ...(request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_STREAM_FRAME) fail('INVALID_RESPONSE', 'Stream frame exceeds its byte budget');
    return value;
}
function terminal(response, request) {
    return { ...response, data: response.status === 'failed' ? { type: 'error', data_type: 'error' } : response.data,
        stream: 'stream-action', message: response.message || response.wording || '', wording: response.wording || response.message || '',
        ...(request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
}
function sendSocket(socket, value, { signal, current = () => true, timeoutMs = 10000 } = {}) {
    if (!current() || signal?.aborted || socket.readyState !== 1) return Promise.reject(Object.assign(new Error('Stream connection closed'), { code: 'EXPIRED' }));
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > MAX_STREAM_FRAME || socket.bufferedAmount > 2 * MAX_STREAM_FRAME) return Promise.reject(Object.assign(new Error('Stream socket backpressure limit reached'), { code: 'BUSY' }));
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = error => {
            if (done) return; done = true; clearTimeout(timer);
            socket.removeListener('close', closed); socket.removeListener('error', closed); signal?.removeEventListener('abort', closed);
            if (error || !current() || signal?.aborted || socket.readyState !== 1) reject(Object.assign(new Error('Stream connection closed'), { code: 'EXPIRED' })); else resolve();
        };
        const closed = () => finish(new Error('closed'));
        const timer = setTimeout(closed, timeoutMs); timer.unref?.();
        socket.once('close', closed); socket.once('error', closed); signal?.addEventListener('abort', closed, { once: true });
        try { socket.send(payload, error => finish(error)); } catch (error) { finish(error); }
    });
}
function writeHttp(response, value, { signal, current = () => true, timeoutMs = 10000 } = {}) {
    if (!current() || signal?.aborted || response.destroyed || response.writableEnded) return Promise.reject(Object.assign(new Error('Stream HTTP connection closed'), { code: 'EXPIRED' }));
    const payload = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(payload) > MAX_STREAM_FRAME) fail('INVALID_RESPONSE', 'Stream HTTP frame exceeds its byte budget');
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = error => {
            if (done) return; done = true; clearTimeout(timer);
            response.removeListener('close', closed); response.removeListener('error', closed); signal?.removeEventListener('abort', closed);
            if (error || !current() || signal?.aborted || response.destroyed) reject(Object.assign(new Error('Stream HTTP connection closed'), { code: 'EXPIRED' })); else resolve();
        };
        const closed = () => finish(new Error('closed'));
        const timer = setTimeout(closed, timeoutMs); timer.unref?.();
        response.once('close', closed); response.once('error', closed); signal?.addEventListener('abort', closed, { once: true });
        try { response.write(payload, error => finish(error)); } catch (error) { finish(error); }
    });
}
module.exports = { STREAMED_ACTIONS, MAX_STREAM_FRAME, frame, terminal, sendSocket, writeHttp };
