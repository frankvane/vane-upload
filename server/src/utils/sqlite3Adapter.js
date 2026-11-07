const BetterSqlite3 = require("better-sqlite3");

const OPEN_READONLY = 1;
const OPEN_READWRITE = 2;
const OPEN_CREATE = 4;

const withCallback = (cb, context, err, result) => {
  if (typeof cb !== "function") return;
  if (err) {
    cb.call(context, err);
    return;
  }
  cb.call(context, null, result);
};

const applyStatement = (statement, method, values) => {
  if (values === undefined || values === null || values === "") {
    return statement[method]();
  }
  if (Array.isArray(values)) {
    return statement[method](...values);
  }
  if (typeof values === "object") {
    try {
      return statement[method](values);
    } catch (firstError) {
      const keys = Object.keys(values);
      if (keys.length > 0) {
        const named = {};
        for (const key of keys) {
          const normalized = key.replace(/^\$/, "");
          if (/^\d+$/.test(normalized)) {
            named[`$${normalized}`] = values[key];
          } else {
            named[key] = values[key];
          }
        }

        try {
          return statement[method](named);
        } catch {
          const sortedNumericKeys = keys
            .map((key) => key.replace(/^\$/, ""))
            .filter((key) => /^\d+$/.test(key))
            .sort((a, b) => Number(a) - Number(b));

          if (sortedNumericKeys.length > 0) {
            const orderedValues = sortedNumericKeys.map((key) => values[key] ?? values[`$${key}`]);
            return statement[method](...orderedValues);
          }
        }
      }
      throw firstError;
    }
  }
  return statement[method](values);
};

const normalizeQuery = (sql, values) => {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { sql, values };
  }

  const matches = [...sql.matchAll(/\$(\d+)/g)];
  if (matches.length === 0) {
    return { sql, values };
  }

  const normalizedSql = sql.replace(/\$\d+/g, "?");
  const normalizedValues = matches.map((match) => {
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(values, `$${key}`)) {
      return values[`$${key}`];
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return values[key];
    }
    return undefined;
  });

  return {
    sql: normalizedSql,
    values: normalizedValues,
  };
};

class Database {
  constructor(filename, mode, callback) {
    const done = (err) => {
      if (typeof callback !== "function") return;
      process.nextTick(() => callback.call(this, err || null));
    };

    try {
      const readonly = (mode & OPEN_READONLY) === OPEN_READONLY;
      const fileMustExist = (mode & OPEN_CREATE) !== OPEN_CREATE && !readonly;
      this._db = new BetterSqlite3(filename, {
        readonly,
        fileMustExist,
      });

      // Improve concurrent write robustness for SQLite.
      try {
        this._db.pragma("busy_timeout = 5000");
        if (!readonly) {
          this._db.pragma("journal_mode = WAL");
          this._db.pragma("synchronous = NORMAL");
        }
      } catch {
        // Ignore pragma setup failures and continue with defaults.
      }

      done(null);
    } catch (error) {
      done(error);
    }
  }

  run(sql, params, callback) {
    const values = typeof params === "function" ? [] : params;
    const cb = typeof params === "function" ? params : callback;

    try {
      const normalized = normalizeQuery(sql, values);
      const statement = this._db.prepare(normalized.sql);
      const result = applyStatement(statement, "run", normalized.values);
      const context = {
        changes: result.changes,
        lastID: result.lastInsertRowid,
      };
      withCallback(cb, context, null);
      return this;
    } catch (error) {
      withCallback(cb, this, error);
      return this;
    }
  }

  all(sql, params, callback) {
    const values = typeof params === "function" ? [] : params;
    const cb = typeof params === "function" ? params : callback;
    try {
      const normalized = normalizeQuery(sql, values);
      const statement = this._db.prepare(normalized.sql);
      let rows;
      try {
        rows = applyStatement(statement, "all", normalized.values);
      } catch (error) {
        if (
          error &&
          typeof error.message === "string" &&
          error.message.includes("does not return data")
        ) {
          applyStatement(statement, "run", normalized.values);
          rows = [];
        } else {
          throw error;
        }
      }
      withCallback(cb, this, null, rows);
      return this;
    } catch (error) {
      withCallback(cb, this, error);
      return this;
    }
  }

  get(sql, params, callback) {
    const values = typeof params === "function" ? [] : params;
    const cb = typeof params === "function" ? params : callback;
    try {
      const normalized = normalizeQuery(sql, values);
      const statement = this._db.prepare(normalized.sql);
      const row = applyStatement(statement, "get", normalized.values);
      withCallback(cb, this, null, row);
      return this;
    } catch (error) {
      withCallback(cb, this, error);
      return this;
    }
  }

  exec(sql, callback) {
    try {
      this._db.exec(sql);
      withCallback(callback, this, null);
      return this;
    } catch (error) {
      withCallback(callback, this, error);
      return this;
    }
  }

  close(callback) {
    try {
      this._db.close();
      withCallback(callback, this, null);
    } catch (error) {
      withCallback(callback, this, error);
    }
  }

  serialize(callback) {
    if (typeof callback === "function") callback();
    return this;
  }

  parallelize(callback) {
    if (typeof callback === "function") callback();
    return this;
  }
}

module.exports = {
  OPEN_READONLY,
  OPEN_READWRITE,
  OPEN_CREATE,
  Database,
};
