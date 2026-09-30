'use strict';

const { AppError } = require('../errors');
const { toPublicWallet } = require('../models/walletRepository');
const { toPublicTransaction } = require('../models/transactionRepository');
const { idempotencyKeySchema } = require('../validation/schemas');
const { toDetails } = require('../middleware/validate');

function createControllers({ transferService, wallets, transactions }) {
  async function getWallet(req, res) {
    res.json({ wallet: toPublicWallet(await wallets.findById(req.user.id), req.user.id) });
  }

  async function deposit(req, res) {
    const wallet = await transferService.deposit(req.user.id, req.body.amount);
    req.log.info({ userId: req.user.id, amount: req.body.amount }, 'deposit');
    res.json({ wallet: toPublicWallet(wallet, req.user.id) });
  }

  async function createTransaction(req, res) {
    const key = idempotencyKeySchema.safeParse(req.get('idempotency-key'));
    if (!key.success) {
      throw AppError.badRequest('Invalid Idempotency-Key header', toDetails(key.error));
    }
    const result = await transferService.createTransfer({
      user: req.user,
      idempotencyKey: key.data,
      body: req.body,
      requestId: req.id,
    });
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    req.log.info(
      { transactionId: result.transaction._id, status: result.transaction.status, replayed: result.replayed },
      'transfer processed',
    );
    res.status(result.status).json({ transaction: toPublicTransaction(result.transaction) });
  }

  async function listTransactions(req, res) {
    const page = await transactions.listForUser(req.user.id, req.validatedQuery);
    if (!page) throw AppError.badRequest('Invalid cursor', [{ field: 'cursor', issue: 'is malformed' }]);
    res.json({ items: page.items.map(toPublicTransaction), nextCursor: page.nextCursor });
  }

  async function getTransaction(req, res) {
    const tx = await transactions.findById(req.params.id);
    // Another user's transaction is reported as missing, not forbidden (contract §0.5).
    if (!tx || (tx.userId !== req.user.id && req.user.role !== 'admin')) {
      throw AppError.notFound('Transaction not found');
    }
    res.json({ transaction: toPublicTransaction(tx) });
  }

  async function updateStatus(req, res) {
    const { status, source, reason, ...rest } = req.body;
    const tx = await transferService.applyTransition(req.params.id, status, { set: rest, source, reason });
    req.log.info({ transactionId: tx._id, status: tx.status, source }, 'status updated');
    res.json({ transaction: toPublicTransaction(tx) });
  }

  async function unfreeze(req, res) {
    const wallet = await transferService.unfreeze(req.params.userId);
    req.log.info({ userId: req.params.userId }, 'account unfrozen');
    res.json({ wallet: toPublicWallet(wallet, req.params.userId) });
  }

  return { getWallet, deposit, createTransaction, listTransactions, getTransaction, updateStatus, unfreeze };
}

module.exports = { createControllers };
