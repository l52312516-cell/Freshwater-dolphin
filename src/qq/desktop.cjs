'use strict';

// Keep QQ's main process and native session alive. Only hide its graphical
// windows after QQ itself has confirmed initialization, identity and online.
function manageDesktop({ capture, electron, enabled = true, expectedUin = '', log = () => {} }) {
    if (!enabled || !capture?.on || !electron?.app?.on || !electron?.BrowserWindow?.getAllWindows) return { close() {} };
    const windows = new Map();
    let background = false, closed = false;
    function valid(window) { try { return window && !window.isDestroyed(); } catch { return false; } }
    function hide(window) {
        if (!background || !valid(window)) return;
        try {
            if (!windows.has(window)) {
                const contents = window.webContents;
                const previous = typeof contents?.getBackgroundThrottling === 'function' ? contents.getBackgroundThrottling() : null;
                const prior = { visible: window.isVisible(), previous };
                prior.show = () => { prior.visible = true; if (background && !closed) hide(window); };
                prior.closed = () => { windows.delete(window); window.removeListener?.('show', prior.show); };
                windows.set(window, prior);
                window.on?.('show', prior.show); window.once?.('closed', prior.closed);
            }
            const contents = window.webContents;
            if (contents && !contents.isDestroyed?.()) contents.setBackgroundThrottling?.(true);
            window.hide();
        } catch { /* A window may close while QQ changes its UI. */ }
    }
    function foreground() {
        background = false;
        for (const [window, prior] of windows) if (valid(window)) {
            try {
                window.removeListener?.('show', prior.show); window.removeListener?.('closed', prior.closed);
                if (typeof prior.previous === 'boolean') window.webContents?.setBackgroundThrottling?.(prior.previous);
                if (prior.visible) window.show();
            } catch {}
        }
        windows.clear();
    }
    function update(event) {
        if (closed || event?.kind !== 'state') return;
        const state = event.status;
        const confirmed = state?.ready === true && state.online === true && /^[1-9]\d{0,15}$/.test(String(state.self?.uin)) &&
            (!expectedUin || String(state.self.uin) === expectedUin) && typeof state.self?.uid === 'string' && /^u_[A-Za-z0-9_-]+$/.test(state.self.uid);
        if (confirmed) {
            background = true;
            for (const window of electron.BrowserWindow.getAllWindows()) hide(window);
        } else if (background) foreground();
    }
    const created = (_event, window) => {
        if (!background || closed) return;
        hide(window);
        window.once?.('ready-to-show', () => { if (!closed) hide(window); });
    };
    capture.on('event', update);
    electron.app.on('browser-window-created', created);
    try { update({ kind: 'state', status: capture.state?.() }); }
    catch { try { log({ code: 'DESKTOP_OPTIMIZATION_UNAVAILABLE' }); } catch {} }
    return { close() {
        if (closed) return;
        closed = true;
        capture.removeListener('event', update);
        electron.app.removeListener('browser-window-created', created);
        foreground();
    } };
}

module.exports = { manageDesktop };
