'use strict';
const { createHash } = require('node:crypto');

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const result = Object.create(null);
        for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
        return result;
    }
    return value;
}

// Use the complete source catalog: admin summaries omit wire parameters.
// Preserve array ordering, which can affect subscription order and indices.
function hostWireFingerprint(hosts) {
    return createHash('sha256').update(JSON.stringify(canonicalize(hosts || []))).digest('hex');
}

module.exports = { hostWireFingerprint };
