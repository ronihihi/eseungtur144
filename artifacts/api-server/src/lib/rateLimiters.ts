import { rateLimit } from "express-rate-limit";

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again later" },
});

export const signingRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again later" },
});

// Prevent authenticated users from exhausting storage / DB with bulk uploads.
// 20 uploads per hour per IP is generous for normal use.
export const uploadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Upload limit reached — try again in an hour" },
});

// Prevent email-bombing recipients through the reminder endpoints.
// 30 reminder sends per 15 minutes per IP is more than enough.
export const remindRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many reminder requests — please try again later" },
});
