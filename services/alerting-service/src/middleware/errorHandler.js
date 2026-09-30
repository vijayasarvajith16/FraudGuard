'use strict';

const { AppError } = require('../errors');

function notFoundHandler(req, _res, next) {
  next(AppError.notFound(`No route for ${req.method} ${req.path}`));
}

/**
 * Final error handler: every error leaves the service in the contract's envelope.
 * Unknown errors are logged with their stack and returned as a generic 500.
 */
// Express identifies error handlers by their four-argument signature.
function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let code = err.code;
  let message = err.message;

  if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Malformed JSON body';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body too large';
  } else if (!(err instanceof AppError) && !(typeof code === 'string' && status < 500)) {
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Internal server error';
  }

  if (status >= 500) {
    req.log?.error({ err }, 'unhandled error');
  }

  const body = { error: { code, message, requestId: req.id } };
  if (err.details) body.error.details = err.details;
  res.status(status).json(body);
}

module.exports = { errorHandler, notFoundHandler };
