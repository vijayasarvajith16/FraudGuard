'use strict';

const { randomUUID } = require('node:crypto');

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Accept the gateway's X-Request-Id (or generate one), expose it as req.id, and echo it back. */
function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

module.exports = { requestId };
