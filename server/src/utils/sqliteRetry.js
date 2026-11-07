const SQLITE_BUSY_PATTERN = /SQLITE_BUSY|database is locked/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isSqliteBusyError = (error) =>
  SQLITE_BUSY_PATTERN.test(String(error?.message || ""));

const withSqliteBusyRetry = async (
  operation,
  { retries = 5, baseDelayMs = 40 } = {}
) => {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= retries) {
        throw error;
      }
      await sleep(baseDelayMs * 2 ** attempt);
      attempt += 1;
    }
  }
};

module.exports = {
  isSqliteBusyError,
  withSqliteBusyRetry,
};
