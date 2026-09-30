'use strict';

const express = require('express');
const { validate } = require('../middleware/validate');
const { captureRoute } = require('../metrics');
const { requireServiceToken } = require('../middleware/serviceToken');
const { lookupQuerySchema } = require('../validation/authSchemas');

/** Service-to-service routes. Never exposed through the gateway (docs/contracts.md §8). */
function createInternalRouter({ controller, internalServiceToken }) {
  const router = express.Router();
  const requireToken = requireServiceToken(internalServiceToken);
  router.get(
    '/users/lookup',
    captureRoute,
    requireToken,
    validate(lookupQuerySchema, 'query'),
    controller.lookupByEmail,
  );
  return router;
}

module.exports = { createInternalRouter };
