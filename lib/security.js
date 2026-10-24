'use strict';

function redactTokenPath(pathname) {
    const match = pathname.match(/^(?:\/sub)?\/([a-zA-Z0-9_-]+)$/);
    if (!match) return pathname;

    const token = match[1];
    if (token.length <= 8) return pathname.replace(token, '***');

    const masked = `${token.slice(0, 4)}...`;
    return pathname.replace(token, masked);
}

function sanitizeClientMetadata(req) {
    return {
        hwid: req.headers['x-hwid'] ? 'present' : 'absent',
        device: req.headers['x-device-model'] ? 'present' : 'absent',
        os: req.headers['x-device-os'] ? 'present' : 'absent',
    };
}

function normalizeRequestId(value, fallback) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(raw)) {
        return raw;
    }
    return fallback;
}

module.exports = {
    normalizeRequestId,
    redactTokenPath,
    sanitizeClientMetadata,
};
