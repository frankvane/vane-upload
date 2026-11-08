const BetterSqlite3 = require("better-sqlite3");

// 注意：这三个常量并非「零引用死代码」。Sequelize 的 sqlite
// connection-manager 通过 dialectModule 隐式读取它们：
//   `defaultReadWriteMode = lib.OPEN_READWRITE | lib.OPEN_CREATE`
// 一旦删除，mode 会变成 0，fileMustExist 被误置为 true，
// 新建数据库文件直接报 "unable to open database file"。
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
    // VU-13 精准修复：命名参数只做「一次规范化 + 一次执行」。
    // 原实现会在首次失败时，用多种策略（保留前缀 / 数字 key 位置展开）反复猜测，
    // 既会吞掉真实 SQL 错误（如 no such column），又可能把命名参数错误绑定到
    // 不正确的位置（产生错误结果而非报错）。这里保留原前缀（Sequelize 可能用
    // :name / @name / $name），仅对纯数字 key 补 $ 前缀以兼容位置占位符的退化
    // 对象传参，然后执行一次；失败立即抛出真实错误，不再回退。
    const named = {};
    for (const key of Object.keys(values)) {
      const normalized = key.replace(/^\$/, "");
      if (/^\d+$/.test(normalized)) {
        named[`$${normalized}`] = values[key];
      } else {
        named[key] = values[key];
      }
    }
    return statement[method](named);
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
        // Sequelize 的 better-sqlite3 适配器对 DDL（CREATE/DROP/PRAGMA 等）
        // 也会走 all()，而这类语句不返回结果集。此回退是兼容层，不可移除，
        // 否则 dropTable/close 等操作会因 "does not return data" 失败。
        // 注意：VU-13 的真正问题在 applyStatement 的「参数绑定」回退，不在此处。
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
