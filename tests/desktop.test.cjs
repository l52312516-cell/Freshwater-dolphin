'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { manageDesktop } = require('../src/qq/desktop.cjs');

function fixture(expectedUin = '') {
    const capture = new EventEmitter(), app = new EventEmitter(), windows = [];
    const electron = { app, BrowserWindow: { getAllWindows: () => windows } };
    const controller = manageDesktop({ capture, electron, expectedUin });
    const update = status => capture.emit('event', { kind: 'state', status });
    function window() {
        const value = new EventEmitter(); let visible = true, destroyed = false, throttled = false;
        value.isDestroyed = () => destroyed; value.isVisible = () => visible;
        value.hide = () => { visible = false; }; value.show = () => { visible = true; value.emit('show'); };
        value.destroy = () => { destroyed = true; value.emit('closed'); };
        value.webContents = { getBackgroundThrottling: () => throttled, setBackgroundThrottling: flag => { throttled = flag; } };
        windows.push(value); return value;
    }
    return { controller, update, window, app, capture };
}
const loggedIn = { ready: true, online: true, self: { uin: '123', uid: 'u_123' } };

test('desktop stays visible until QQ confirms identity, readiness and online', () => {
    const f = fixture(), window = f.window();
    for (const status of [{ ready: true }, { ...loggedIn, online: null }, { ...loggedIn, self: null }, { ...loggedIn, ready: false }]) {
        f.update(status); assert.equal(window.isVisible(), true);
    }
    f.update(loggedIn); assert.equal(window.isVisible(), false);
    assert.equal(window.webContents.getBackgroundThrottling(), true);
    assert.equal(window.isDestroyed(), false);
    f.controller.close();
});
test('QQ offline or session loss restores windows and previous rendering settings', () => {
    const f = fixture(), window = f.window();
    f.update(loggedIn); f.update({ ...loggedIn, online: false });
    assert.equal(window.isVisible(), true); assert.equal(window.webContents.getBackgroundThrottling(), false);
    f.update(loggedIn); f.update({ ready: false }); assert.equal(window.isVisible(), true);
    f.controller.close();
});
test('new QQ windows are hidden in background and closed-window listeners are released', () => {
    const f = fixture(), window = f.window(); f.update(loggedIn);
    const second = f.window(); f.app.emit('browser-window-created', {}, second);
    second.show(); assert.equal(second.isVisible(), false);
    second.destroy(); assert.equal(second.listenerCount('show'), 0);
    f.controller.close();
    assert.equal(window.isVisible(), true);
    assert.equal(window.listenerCount('show'), 0);
    assert.equal(f.capture.listenerCount('event'), 0); assert.equal(f.app.listenerCount('browser-window-created'), 0);
});
test('unknown online state or mismatched identity restores the login window', () => {
    const f = fixture('123'), window = f.window();
    f.update(loggedIn); assert.equal(window.isVisible(), false);
    f.update({ ...loggedIn, online: null }); assert.equal(window.isVisible(), true);
    f.update(loggedIn); assert.equal(window.isVisible(), false);
    f.update({ ...loggedIn, self: { uin: '456', uid: 'u_456' } }); assert.equal(window.isVisible(), true);
    f.controller.close();
});
