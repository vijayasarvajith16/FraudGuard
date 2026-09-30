'use strict';

const bcrypt = require('bcrypt');
const { EmailTakenError } = require('./models/userRepository');

/**
 * Create the admin account from ADMIN_EMAIL / ADMIN_PASSWORD if it does not exist yet.
 * This is the only way an admin can be created (docs/contracts.md §1). It never
 * changes an existing account, so rotating ADMIN_PASSWORD later has no effect.
 */
async function bootstrapAdmin({ users, admin, bcryptRounds, logger }) {
  if (!admin) return;
  if (await users.findByEmail(admin.email)) {
    logger.info({ email: admin.email }, 'admin bootstrap skipped: account exists');
    return;
  }
  const passwordHash = await bcrypt.hash(admin.password, bcryptRounds);
  try {
    await users.create({ email: admin.email, name: 'Administrator', passwordHash, role: 'admin' });
    logger.info({ email: admin.email }, 'admin account created');
  } catch (err) {
    // Another replica created it at the same moment.
    if (!(err instanceof EmailTakenError)) throw err;
  }
}

module.exports = { bootstrapAdmin };
