import express from "express";
import cors from "cors";
import { handleDemo } from "./routes/demo";
import { handleBookingSubmission } from "./routes/booking";
import {
  validateSubscriptionId,
  listSubscriptionTypes,
} from "./routes/subscription";
import { handleSendOtp, handleVerifyOtp } from "./routes/otp";
import {
  getSystemHealth,
  getAnalyticsDashboard,
  getRealTimeMetrics,
} from "./routes/monitoring";
import { initializeCache } from "./utils/cache";
import { sqliteDb } from "./utils/sqlite-db";
import { requestLogger, Analytics } from "./utils/logger";
import {
  generalRateLimit,
  subscriptionValidationRateLimit,
  otpRateLimit,
  bookingSubmissionRateLimit,
} from "./middleware/rateLimiter";
import {
  errorTrackingMiddleware,
  errorTrackingHealthCheck,
} from "./middleware/errorTracking";

const dbType =
  process.env.POSTGRES_URL || process.env.DATABASE_URL
    ? "PostgreSQL"
    : "SQLite";

const getDatabaseHealth: any = async (_req: any, res: any) => {
  try {
    const health = await sqliteDb.healthCheck();
    res.json({
      database: dbType,
      status: health.connected ? "connected" : "disconnected",
      totalSubscriptions: health.totalSubscriptions,
      totalBookings: health.totalBookings,
      error: health.error,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      database: dbType,
      status: "error",
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
};

export async function createServer() {
  const app = express();

  // Initialize cache (independent of primary DB)
  try {
    await initializeCache();
    console.info("✓ SQLite cache initialized successfully");
  } catch (error) {
    console.warn(
      "⚠ SQLite cache initialization failed, continuing without cache:",
      error,
    );
  }

  // Initialize primary database
  try {
    const initialized = await sqliteDb.initialize();
    if (initialized) {
      console.info(`✓ ${dbType} database initialized successfully`);
    } else {
      console.warn(`⚠ ${dbType} database initialization failed`);
    }
  } catch (error) {
    console.warn(`⚠ ${dbType} database initialization error:`, error);
  }

  // Trust proxy for accurate IP addresses
  app.set("trust proxy", 1);

  // Core middleware
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use(requestLogger);

  // Apply general rate limiting to all API routes
  if (!process.env.VITEST) {
    app.use("/api", generalRateLimit.middleware());
  }

  // Health check endpoints (no rate limiting)
  app.get("/api/ping", (_req, res) => {
    const ping = process.env.PING_MESSAGE ?? "ping";
    res.json({ message: ping });
  });

  // Health check and monitoring endpoints
  app.get("/api/health/error-tracking", errorTrackingHealthCheck);
  app.get("/api/health/system", getSystemHealth);
  app.get("/api/health/database", getDatabaseHealth);
  app.get("/api/monitoring/dashboard", getAnalyticsDashboard);
  app.get("/api/monitoring/metrics", getRealTimeMetrics);

  // Demo route
  app.get("/api/demo", handleDemo);

  // Booking submission with specific rate limiting
  app.post(
    "/api/booking",
    bookingSubmissionRateLimit.middleware(),
    (req, res, next) => {
      Analytics.trackFormProgress("booking_submission_attempt", req.ip);
      next();
    },
    handleBookingSubmission,
  );

  // Subscription validation with specific rate limiting
  app.post(
    "/api/subscription/validate",
    subscriptionValidationRateLimit.middleware(),
    validateSubscriptionId,
  );

  app.get("/api/subscription/types", listSubscriptionTypes);

  // OTP routes with specific rate limiting
  if (!process.env.VITEST) {
    app.post(
      "/api/otp/send",
      otpRateLimit.middleware(),
      (req, res, next) => {
        Analytics.trackFormProgress("otp_request", req.ip);
        next();
      },
      handleSendOtp,
    );

    app.post("/api/otp/verify", otpRateLimit.middleware(), handleVerifyOtp);
  } else {
    app.post("/api/otp/send", handleSendOtp);
    app.post("/api/otp/verify", handleVerifyOtp);
  }

  // Enhanced error handling middleware
  app.use(errorTrackingMiddleware);

  return app;
}
