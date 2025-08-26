import type { RequestHandler } from "express";
import { Analytics } from "../utils/logger";
import { sqliteDb } from "../utils/sqlite-db";

const dbType = process.env.POSTGRES_URL || process.env.DATABASE_URL ? "PostgreSQL" : "SQLite";

export const getDatabaseHealth: RequestHandler = async (req, res) => {
  const startTime = Date.now();

  try {
    const health = await sqliteDb.healthCheck();

    const response = {
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      database: {
        type: dbType,
        connected: health.connected,
        totalSubscriptions: health.totalSubscriptions,
        totalBookings: health.totalBookings,
        error: health.error,
      },
      environment: {
        NODE_ENV: process.env.NODE_ENV || "unknown",
      },
    };

    if (!health.connected) {
      console.error(`❌ ${dbType} health check failed:`, {
        error: health.error,
        timestamp: response.timestamp,
      });

      Analytics.trackError(
        new Error(`${dbType} health check failed: ${health.error}`),
        "db_health_check",
        {
          error: health.error,
          ip: req.ip,
        },
      );
    }

    Analytics.trackPerformance("db_health_check", Date.now() - startTime, {
      connected: health.connected,
      totalSubscriptions: health.totalSubscriptions,
      totalBookings: health.totalBookings,
      dbType,
    });

    const httpStatus = health.connected ? 200 : 503;
    res.status(httpStatus).json(response);
  } catch (error) {
    console.error(`❌ ${dbType} health check endpoint error:`, error);

    Analytics.trackError(error as Error, "db_health_check_endpoint", {
      ip: req.ip,
      context: "health_check_route",
    });

    res.status(500).json({
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      error: "Health check endpoint failed",
      database: {
        connected: false,
        error: "Health check execution failed",
      },
    });
  }
};

export const getDatabaseConnectionInfo: RequestHandler = async (_req, res) => {
  try {
    const health = await sqliteDb.healthCheck();

    res.json({
      timestamp: new Date().toISOString(),
      connection: {
        type: dbType,
        connected: health.connected,
        totalSubscriptions: health.totalSubscriptions,
        totalBookings: health.totalBookings,
      },
      environment: {
        NODE_ENV: process.env.NODE_ENV || "unknown",
      },
    });
  } catch (error) {
    console.error(`${dbType} connection info error:`, error);
    res.status(500).json({
      error: "Failed to get database connection info",
      timestamp: new Date().toISOString(),
    });
  }
};

export const testDatabaseConnection: RequestHandler = async (req, res) => {
  const startTime = Date.now();

  try {
    console.info(`🔄 Testing ${dbType} database connection...`);

    const health = await sqliteDb.healthCheck();

    if (!health.connected) {
      return res.status(503).json({
        success: false,
        error: health.error,
        responseTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    }

    console.info(`✅ ${dbType} database connection test successful`);

    res.json({
      success: true,
      type: dbType,
      responseTime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      totalSubscriptions: health.totalSubscriptions,
      totalBookings: health.totalBookings,
    });
  } catch (error) {
    console.error(`❌ ${dbType} connection test failed:`, error);

    Analytics.trackError(error as Error, "db_connection_test", {
      ip: req.ip,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      responseTime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  }
};

export const getDatabaseSchema: RequestHandler = async (_req, res) => {
  try {
    const health = await sqliteDb.healthCheck();

    res.json({
      timestamp: new Date().toISOString(),
      schema: {
        type: dbType,
        connected: health.connected,
        tables: ["subscription_ids", "booking_requests"],
        totalSubscriptions: health.totalSubscriptions,
        totalBookings: health.totalBookings,
        error: health.error,
      },
    });
  } catch (error) {
    console.error(`${dbType} schema check error:`, error);
    res.status(500).json({
      error: "Failed to check database schema",
      timestamp: new Date().toISOString(),
    });
  }
};

export const initializeDatabaseSchema: RequestHandler = async (req, res) => {
  const startTime = Date.now();

  try {
    console.info(`🔄 Initializing ${dbType} database schema...`);

    const result = await sqliteDb.initialize();

    if (result) {
      console.info(`✅ ${dbType} database schema initialization successful`);
      const health = await sqliteDb.healthCheck();
      res.json({
        success: true,
        message: `${dbType} database schema initialized successfully`,
        responseTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        totalSubscriptions: health.totalSubscriptions,
        totalBookings: health.totalBookings,
      });
    } else {
      res.status(500).json({
        success: false,
        message: `${dbType} database schema initialization failed`,
        responseTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error(`❌ ${dbType} schema initialization failed:`, error);

    Analytics.trackError(error as Error, "db_schema_init", {
      ip: req.ip,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      responseTime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  }
};
