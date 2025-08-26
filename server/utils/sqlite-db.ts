import initSqlJs from "sql.js";
import fs from "fs";
import path from "path";
import { Analytics } from "./logger";
import { Pool } from "pg";

export interface SubscriptionRecord {
  id?: number;
  subscription_id: string;
  user_name: string;
  subscription_type: "premium" | "elite" | "standard";
  is_active: boolean;
  created_at: string;
  expires_at?: string | null;
  last_used_at?: string | null;
  usage_count: number;
}

export interface BookingRecord {
  id?: number;
  booking_id: string;
  celebrity: string;
  full_name: string;
  email: string;
  phone: string;
  organization?: string | null;
  event_type: string;
  event_date?: string | null;
  location: string;
  budget_range: string;
  custom_amount?: number | null;
  attendees: string;
  special_requests: string;
  subscription_id?: string | null;
  privacy_consent: boolean;
  created_at: string;
  status: "pending" | "confirmed" | "completed" | "cancelled";
}

interface IDatabaseManager {
  initialize(): Promise<boolean>;
  validateSubscription(subscriptionId: string): Promise<{
    isValid: boolean;
    subscriptionType?: string;
    userName?: string;
    message: string;
  }>;
  getSubscriptionTypes(): Promise<{
    subscriptionTypes: Array<{ subscription_type: string; count: string }>;
    totalActive: number;
  }>;
  saveBooking(
    booking: Omit<BookingRecord, "id" | "created_at">
  ): Promise<string>;
  getBookings(limit?: number): Promise<BookingRecord[]>;
  healthCheck(): Promise<{
    connected: boolean;
    totalSubscriptions: number;
    totalBookings: number;
    error?: string;
  }>;
  close(): Promise<void>;
}

// ================================
// PostgreSQL implementation
// ================================
class PostgresManager implements IDatabaseManager {
  private static instance: PostgresManager;
  private pool: Pool | null = null;
  private sqlitePath = process.env.SQLITE_DB_PATH || "server/db/hybe.db";

  static getInstance(): PostgresManager {
    if (!PostgresManager.instance) {
      PostgresManager.instance = new PostgresManager();
    }
    return PostgresManager.instance;
  }

  private getPool(): Pool {
    if (this.pool) return this.pool;
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("POSTGRES_URL is not set");
    }
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    return this.pool;
  }

  async initialize(): Promise<boolean> {
    try {
      const pool = this.getPool();
      // Create tables
      await pool.query(`
        CREATE TABLE IF NOT EXISTS subscription_ids (
          id SERIAL PRIMARY KEY,
          subscription_id TEXT UNIQUE NOT NULL,
          user_name TEXT NOT NULL,
          subscription_type TEXT NOT NULL CHECK (subscription_type IN ('premium','elite','standard')),
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          last_used_at TIMESTAMPTZ,
          usage_count INTEGER DEFAULT 0
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS booking_requests (
          id SERIAL PRIMARY KEY,
          booking_id TEXT UNIQUE NOT NULL,
          celebrity TEXT NOT NULL,
          full_name TEXT NOT NULL,
          email TEXT NOT NULL,
          phone TEXT NOT NULL,
          organization TEXT,
          event_type TEXT NOT NULL,
          event_date TIMESTAMPTZ,
          location TEXT NOT NULL,
          budget_range TEXT NOT NULL,
          custom_amount NUMERIC,
          attendees TEXT NOT NULL,
          special_requests TEXT,
          subscription_id TEXT,
          privacy_consent BOOLEAN NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          status TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled'))
        );
      `);
      // Indexes
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_subscription_ids_active ON subscription_ids (subscription_id, is_active);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_subscription_ids_expires ON subscription_ids (expires_at);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_created ON booking_requests (created_at);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_subscription ON booking_requests (subscription_id);`);

      // Migrate data from SQLite if empty
      const { rows: subCountRows } = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM subscription_ids"
      );
      const { rows: bookCountRows } = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM booking_requests"
      );
      const subCount = parseInt(subCountRows[0]?.count || "0", 10);
      const bookingCount = parseInt(bookCountRows[0]?.count || "0", 10);

      if ((subCount === 0 || bookingCount === 0) && fs.existsSync(this.sqlitePath)) {
        try {
          await this.migrateFromSQLite();
        } catch (migrateErr) {
          console.warn("SQLite to Postgres migration skipped/failed:", migrateErr);
        }
      }

      console.info("✅ PostgreSQL initialized successfully");
      return true;
    } catch (error) {
      console.error("❌ Failed to initialize PostgreSQL:", error);
      Analytics.trackError(error as Error, "postgres_initialization", {});
      return false;
    }
  }

  private async migrateFromSQLite() {
    const dbPath = this.sqlitePath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) return;

    const wasmUrl = path.join("node_modules", "sql.js", "dist", "sql-wasm.wasm");
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });

    let buffer: Buffer | null = null;
    if (fs.existsSync(dbPath)) {
      buffer = fs.readFileSync(dbPath);
    } else {
      return;
    }

    const sqliteDb = new SQL.Database(buffer);
    const pool = this.getPool();

    await pool.query("BEGIN");
    try {
      // Migrate subscription_ids
      const subRes = sqliteDb.exec("SELECT subscription_id, user_name, subscription_type, is_active, created_at, expires_at, last_used_at, usage_count FROM subscription_ids");
      if (subRes[0]) {
        const stmtText = `INSERT INTO subscription_ids (subscription_id, user_name, subscription_type, is_active, created_at, expires_at, last_used_at, usage_count)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                          ON CONFLICT (subscription_id) DO NOTHING`;
        for (const row of subRes[0].values) {
          const [subscription_id, user_name, subscription_type, is_active, created_at, expires_at, last_used_at, usage_count] = row as any[];
          await pool.query(stmtText, [
            String(subscription_id),
            String(user_name),
            String(subscription_type),
            Boolean(is_active),
            created_at ? new Date(created_at) : new Date(),
            expires_at ? new Date(expires_at) : null,
            last_used_at ? new Date(last_used_at) : null,
            Number(usage_count) || 0,
          ]);
        }
      }

      // Migrate booking_requests
      const bookRes = sqliteDb.exec("SELECT booking_id, celebrity, full_name, email, phone, organization, event_type, event_date, location, budget_range, custom_amount, attendees, special_requests, subscription_id, privacy_consent, created_at, status FROM booking_requests");
      if (bookRes[0]) {
        const stmtText = `INSERT INTO booking_requests (
            booking_id, celebrity, full_name, email, phone, organization, event_type, event_date, location,
            budget_range, custom_amount, attendees, special_requests, subscription_id, privacy_consent, created_at, status
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,
            $10,$11,$12,$13,$14,$15,$16,$17
          ) ON CONFLICT (booking_id) DO NOTHING`;
        for (const row of bookRes[0].values) {
          const [booking_id, celebrity, full_name, email, phone, organization, event_type, event_date, location, budget_range, custom_amount, attendees, special_requests, subscription_id, privacy_consent, created_at, status] = row as any[];
          await pool.query(stmtText, [
            String(booking_id),
            String(celebrity),
            String(full_name),
            String(email),
            String(phone),
            organization != null ? String(organization) : null,
            String(event_type),
            event_date ? new Date(event_date) : null,
            String(location),
            String(budget_range),
            custom_amount != null ? Number(custom_amount) : null,
            String(attendees),
            String(special_requests),
            subscription_id != null ? String(subscription_id) : null,
            Boolean(privacy_consent),
            created_at ? new Date(created_at) : new Date(),
            String(status),
          ]);
        }
      }

      await pool.query("COMMIT");
      console.info("✅ Migrated data from SQLite to PostgreSQL");
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    } finally {
      sqliteDb.close();
    }
  }

  async validateSubscription(subscriptionId: string) {
    try {
      const pool = this.getPool();
      const { rows } = await pool.query(
        `SELECT subscription_id, user_name, subscription_type, is_active, expires_at, usage_count
         FROM subscription_ids WHERE subscription_id = $1 AND is_active = TRUE`,
        [subscriptionId]
      );

      const result = rows[0];
      if (!result) {
        return {
          isValid: false,
          message: "Subscription ID not found, inactive, or expired. Please check your ID and try again.",
        };
      }

      if (result.expires_at && new Date(result.expires_at) < new Date()) {
        return { isValid: false, message: "Subscription has expired. Please renew your membership." };
      }

      await pool.query(
        `UPDATE subscription_ids SET usage_count = usage_count + 1, last_used_at = NOW() WHERE subscription_id = $1`,
        [subscriptionId]
      );

      return {
        isValid: true,
        subscriptionType: result.subscription_type,
        userName: result.user_name,
        message: `Valid ${result.subscription_type} subscription for ${result.user_name}`,
      };
    } catch (error) {
      console.error("❌ Subscription validation error (Postgres):", error);
      Analytics.trackError(error as Error, "postgres_subscription_validation", {
        subscriptionId,
      });
      return {
        isValid: false,
        message: "Service temporarily unavailable. Please try again later.",
      };
    }
  }

  async getSubscriptionTypes() {
    try {
      const pool = this.getPool();
      const { rows } = await pool.query<{
        subscription_type: string;
        count: string;
      }>(
        `SELECT subscription_type, COUNT(*)::text as count FROM subscription_ids WHERE is_active = TRUE GROUP BY subscription_type ORDER BY subscription_type`
      );

      const subscriptionTypes = rows.map((r) => ({
        subscription_type: r.subscription_type,
        count: r.count,
      }));
      const totalActive = subscriptionTypes.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
      return { subscriptionTypes, totalActive };
    } catch (error) {
      console.error("❌ Error fetching subscription types (Postgres):", error);
      return { subscriptionTypes: [], totalActive: 0 };
    }
  }

  async saveBooking(booking: Omit<BookingRecord, "id" | "created_at">) {
    try {
      const pool = this.getPool();
      await pool.query(
        `INSERT INTO booking_requests (
          booking_id, celebrity, full_name, email, phone, organization, event_type, event_date, location,
          budget_range, custom_amount, attendees, special_requests, subscription_id, privacy_consent, status
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,
          $10,$11,$12,$13,$14,$15,$16
        )`,
        [
          booking.booking_id,
          booking.celebrity,
          booking.full_name,
          booking.email,
          booking.phone,
          booking.organization ?? null,
          booking.event_type,
          booking.event_date ? new Date(booking.event_date) : null,
          booking.location,
          booking.budget_range,
          booking.custom_amount ?? null,
          booking.attendees,
          booking.special_requests,
          booking.subscription_id ?? null,
          booking.privacy_consent,
          booking.status,
        ]
      );
      console.info(`✅ Booking saved to PostgreSQL: ${booking.booking_id}`);
      return booking.booking_id;
    } catch (error) {
      console.error("❌ Error saving booking to PostgreSQL:", error);
      Analytics.trackError(error as Error, "postgres_booking_save", {
        bookingId: booking.booking_id,
      });
      throw error;
    }
  }

  async getBookings(limit = 50): Promise<BookingRecord[]> {
    try {
      const pool = this.getPool();
      const { rows } = await pool.query<BookingRecord>(
        `SELECT id, booking_id, celebrity, full_name, email, phone, organization, event_type, event_date::text as event_date, location, budget_range, 
                custom_amount::float as custom_amount, attendees, special_requests, subscription_id, privacy_consent, created_at::text as created_at, status
         FROM booking_requests ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return rows;
    } catch (error) {
      console.error("❌ Error fetching bookings (Postgres):", error);
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      console.info("🔒 PostgreSQL pool closed");
    }
  }

  async healthCheck() {
    try {
      const pool = this.getPool();
      const sub = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM subscription_ids"
      );
      const book = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM booking_requests"
      );
      return {
        connected: true,
        totalSubscriptions: parseInt(sub.rows[0]?.count || "0", 10),
        totalBookings: parseInt(book.rows[0]?.count || "0", 10),
      };
    } catch (error) {
      return {
        connected: false,
        totalSubscriptions: 0,
        totalBookings: 0,
        error: (error as Error).message,
      };
    }
  }
}

// ================================
// Existing SQLite implementation (fallback)
// ================================
class SQLiteManager implements IDatabaseManager {
  private static instance: SQLiteManager;
  private database: initSqlJs.Database | null = null;
  private dbPath = process.env.SQLITE_DB_PATH || "server/db/hybe.db";

  private constructor() {}

  static getInstance(): SQLiteManager {
    if (!SQLiteManager.instance) {
      SQLiteManager.instance = new SQLiteManager();
    }
    return SQLiteManager.instance;
  }

  async initialize(): Promise<boolean> {
    if (this.database) {
      return true;
    }

    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const wasmUrl = path.join(
        "node_modules",
        "sql.js",
        "dist",
        "sql-wasm.wasm",
      );
      const SQL = await initSqlJs({
        locateFile: () => wasmUrl,
      });

      let buffer: Buffer | null = null;
      if (fs.existsSync(this.dbPath)) {
        buffer = fs.readFileSync(this.dbPath);
      }

      this.database = new SQL.Database(buffer);
      await this.createTables();
      await this.insertSampleData();
      this.saveToFile();

      console.info("✅ SQLite database initialized successfully");
      return true;
    } catch (error) {
      console.error("❌ Failed to initialize SQLite database:", error);
      Analytics.trackError(error as Error, "sqlite_initialization", {
        dbPath: this.dbPath,
      });
      return false;
    }
  }

  private async createTables(): Promise<void> {
    if (!this.database) {
      throw new Error("Database not initialized");
    }

    this.database.run(`
      CREATE TABLE IF NOT EXISTS subscription_ids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id TEXT UNIQUE NOT NULL,
        user_name TEXT NOT NULL,
        subscription_type TEXT NOT NULL CHECK(subscription_type IN ('premium', 'elite', 'standard')),
        is_active BOOLEAN DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT,
        last_used_at TEXT,
        usage_count INTEGER DEFAULT 0
      )
    `);

    this.database.run(`
      CREATE TABLE IF NOT EXISTS booking_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id TEXT UNIQUE NOT NULL,
        celebrity TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        organization TEXT,
        event_type TEXT NOT NULL,
        event_date TEXT,
        location TEXT NOT NULL,
        budget_range TEXT NOT NULL,
        custom_amount REAL,
        attendees TEXT NOT NULL,
        special_requests TEXT,
        subscription_id TEXT,
        privacy_consent BOOLEAN NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'completed', 'cancelled')),
        FOREIGN KEY (subscription_id) REFERENCES subscription_ids(subscription_id)
      )
    `);

    this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_subscription_ids_active 
      ON subscription_ids(subscription_id, is_active) 
    `);

    this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_subscription_ids_expires 
      ON subscription_ids(expires_at) 
    `);

    this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_booking_requests_created 
      ON booking_requests(created_at)
    `);

    this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_booking_requests_subscription 
      ON booking_requests(subscription_id)
    `);

    console.info("✅ SQLite tables created successfully");
  }

  private async insertSampleData(): Promise<void> {
    if (!this.database) {
      throw new Error("Database not initialized");
    }

    const existingCount = this.database.exec(
      "SELECT COUNT(*) as count FROM subscription_ids",
    )[0];
    if (existingCount && (existingCount.values[0][0] as number) > 0) {
      console.info("📊 SQLite sample data already exists, skipping insertion");
      return;
    }

    const subscriptions = [
      { id: "HYBABC1234567", name: "Kim Taehyung", type: "premium" },
      { id: "HYBGHI5555555", name: "Jeon Jungkook", type: "premium" },
      { id: "HYBPQR8888888", name: "Jung Hoseok", type: "premium" },
      { id: "HYBAAA6666666", name: "Park Chaeyoung", type: "premium" },
      { id: "HYBDDD1234321", name: "Hanni Pham", type: "premium" },
      { id: "HYBDEF9876543", name: "Park Jimin", type: "elite" },
      { id: "HYBJKL7777777", name: "Kim Namjoon", type: "elite" },
      { id: "HYBSTU1111111", name: "Kim Seokjin", type: "elite" },
      { id: "HYBYZZ4444444", name: "Kim Jennie", type: "elite" },
      { id: "HYBCCC0000000", name: "Minji Kim", type: "elite" },
      { id: "HYBFFF9012345", name: "Haerin Kang", type: "elite" },
      { id: "B07200EF6667", name: "Radhika Verma", type: "standard" },
      { id: "HYB10250GB0680", name: "Elisabete Magalhaes", type: "standard" },
      { id: "HYB59371A4C9F2", name: "MEGHANA VAISHNAVI", type: "standard" },
    ];

    const stmt = this.database.prepare(`
      INSERT INTO subscription_ids (subscription_id, user_name, subscription_type, expires_at)
      VALUES (?, ?, ?, ?)
    `);

    subscriptions.forEach((sub) => {
      const expiresAt =
        sub.type === "premium"
          ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          : sub.type === "elite"
            ? new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
            : null;

      stmt.run([sub.id, sub.name, sub.type, expiresAt]);
    });

    stmt.free();
    this.saveToFile();
    console.info("📊 SQLite sample subscription data inserted successfully");
  }

  private saveToFile(): void {
    if (!this.database) return;

    try {
      const data = this.database.export();
      fs.writeFileSync(this.dbPath, data);
    } catch (error) {
      console.error("❌ Failed to save SQLite database to file:", error);
    }
  }

  async validateSubscription(subscriptionId: string) {
    if (!this.database) {
      await this.initialize();
    }

    if (!this.database) {
      return {
        isValid: false,
        message: "Database not available",
      };
    }

    try {
      const normalizedId = subscriptionId.trim().toUpperCase();

      const stmt = this.database.prepare(`
        SELECT subscription_id, user_name, subscription_type, is_active, expires_at, usage_count
        FROM subscription_ids
        WHERE subscription_id = ? AND is_active = 1
      `);

      const result = stmt.get([normalizedId]);
      stmt.free();

      if (!result) {
        return {
          isValid: false,
          message:
            "Subscription ID not found, inactive, or expired. Please check your ID and try again.",
        };
      }

      const expiresRaw = result[4] as any;
      const expiresAtDate = expiresRaw ? new Date(String(expiresRaw)) : null;
      if (expiresAtDate && expiresAtDate < new Date()) {
        return {
          isValid: false,
          message: "Subscription has expired. Please renew your membership.",
        };
      }

      const updateStmt = this.database.prepare(`
        UPDATE subscription_ids 
        SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP
        WHERE subscription_id = ?
      `);
      updateStmt.run([normalizedId]);
      updateStmt.free();
      this.saveToFile();

      const subscriptionType = String(result[2]);
      const userName = String(result[1]);
      return {
        isValid: true,
        subscriptionType,
        userName,
        message: `Valid ${subscriptionType} subscription for ${userName}`,
      };
    } catch (error) {
      console.error("❌ Subscription validation error:", error);
      Analytics.trackError(error as Error, "sqlite_subscription_validation", {
        subscriptionId,
      });
      return {
        isValid: false,
        message: "Service temporarily unavailable. Please try again later.",
      };
    }
  }

  async getSubscriptionTypes() {
    if (!this.database) {
      await this.initialize();
    }

    if (!this.database) {
      return { subscriptionTypes: [], totalActive: 0 };
    }

    try {
      const result = this.database.exec(`
        SELECT subscription_type, COUNT(*) as count
        FROM subscription_ids
        WHERE is_active = 1
        GROUP BY subscription_type
        ORDER BY subscription_type
      `);

      if (!result[0]) {
        return { subscriptionTypes: [], totalActive: 0 };
      }

      const subscriptionTypes = result[0].values.map((row) => ({
        subscription_type: row[0] as string,
        count: row[1] as string,
      }));

      const totalActive = subscriptionTypes.reduce(
        (sum, row) => sum + parseInt(row.count),
        0,
      );

      return { subscriptionTypes, totalActive };
    } catch (error) {
      console.error("❌ Error fetching subscription types:", error);
      return { subscriptionTypes: [], totalActive: 0 };
    }
  }

  async saveBooking(
    booking: Omit<BookingRecord, "id" | "created_at">,
  ): Promise<string> {
    if (!this.database) {
      await this.initialize();
    }

    if (!this.database) {
      throw new Error("Database not available");
    }

    try {
      const stmt = this.database.prepare(`
        INSERT INTO booking_requests (
          booking_id, celebrity, full_name, email, phone, organization,
          event_type, event_date, location, budget_range, custom_amount,
          attendees, special_requests, subscription_id, privacy_consent, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run([
        booking.booking_id,
        booking.celebrity,
        booking.full_name,
        booking.email,
        booking.phone,
        booking.organization || null,
        booking.event_type,
        booking.event_date || null,
        booking.location,
        booking.budget_range,
        booking.custom_amount || null,
        booking.attendees,
        booking.special_requests,
        booking.subscription_id || null,
        booking.privacy_consent ? 1 : 0,
        booking.status,
      ]);

      stmt.free();
      this.saveToFile();

      console.info(`✅ Booking saved to SQLite: ${booking.booking_id}`);
      return booking.booking_id;
    } catch (error) {
      console.error("❌ Error saving booking to SQLite:", error);
      Analytics.trackError(error as Error, "sqlite_booking_save", {
        bookingId: booking.booking_id,
      });
      throw error;
    }
  }

  async getBookings(limit = 50): Promise<BookingRecord[]> {
    if (!this.database) {
      await this.initialize();
    }

    if (!this.database) {
      return [];
    }

    try {
      const result = this.database.exec(`
        SELECT * FROM booking_requests
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);

      if (!result[0]) {
        return [];
      }

      const columns = result[0].columns;
      return result[0].values.map((row) => {
        const booking: any = {};
        columns.forEach((col, index) => {
          booking[col] = row[index];
        });
        return booking as BookingRecord;
      });
    } catch (error) {
      console.error("❌ Error fetching bookings:", error);
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.database) {
      this.database.close();
      this.database = null;
      console.info("🔒 SQLite database connection closed");
    }
  }

  async healthCheck() {
    try {
      if (!this.database) {
        await this.initialize();
      }

      if (!this.database) {
        return {
          connected: false,
          totalSubscriptions: 0,
          totalBookings: 0,
          error: "Database initialization failed",
        };
      }

      const subResult = this.database.exec(
        "SELECT COUNT(*) FROM subscription_ids",
      );
      const bookingResult = this.database.exec(
        "SELECT COUNT(*) FROM booking_requests",
      );

      return {
        connected: true,
        totalSubscriptions: (subResult[0]?.values[0]?.[0] as number) || 0,
        totalBookings: (bookingResult[0]?.values[0]?.[0] as number) || 0,
      };
    } catch (error) {
      return {
        connected: false,
        totalSubscriptions: 0,
        totalBookings: 0,
        error: (error as Error).message,
      };
    }
  }
}

// ================================
// Export a single manager chosen by env
// ================================
const usingPostgres = !!(process.env.POSTGRES_URL || process.env.DATABASE_URL);

const manager: IDatabaseManager = usingPostgres
  ? PostgresManager.getInstance()
  : SQLiteManager.getInstance();

export const sqliteDb = manager;
