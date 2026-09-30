'use strict';

const { AppError } = require('../errors');

/** Convert zod issues into the contract's `details` array. */
function toDetails(zodError) {
  return zodError.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    issue: issue.message,
  }));
}

/**
 * Validate `req[source]` against a zod schema and replace it with the parsed value.
 * Express 5 makes req.query a getter, so parsed query values go to req.validatedQuery.
 */
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      return next(AppError.badRequest('Request validation failed', toDetails(result.error)));
    }
    if (source === 'query') req.validatedQuery = result.data;
    else req[source] = result.data;
    return next();
  };
}

module.exports = { validate, toDetails };
