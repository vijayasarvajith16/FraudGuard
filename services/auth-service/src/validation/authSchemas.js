'use strict';

const { z } = require('zod');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'must be at most 254 characters')
  .pipe(z.email('must be a valid email address'));

// Contract §1.1: 8-128 chars, at least one letter and one digit.
const password = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(128, 'must be at most 128 characters')
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/\d/, 'must contain a digit');

const registerSchema = z.strictObject({
  email,
  password,
  name: z.string().trim().min(1, 'is required').max(80, 'must be at most 80 characters'),
});

// Login does not enforce password rules: the rules might change after an account was created.
const loginSchema = z.strictObject({
  email,
  password: z.string().min(1, 'is required').max(128),
});

const lookupQuerySchema = z.strictObject({ email });

module.exports = { registerSchema, loginSchema, lookupQuerySchema };
