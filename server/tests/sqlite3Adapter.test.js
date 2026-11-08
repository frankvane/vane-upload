// sqlite3Adapter 行为回归测试：
// - 正常 SELECT（位置参数 / 命名参数）按预期返回行
// - 真实错误（语法/表不存在/绑定数量不匹配/列不存在）会冒泡，不被静默吞掉
// - 对 DDL（CREATE/DROP）经 all() 调用时保持兼容（Sequelize 依赖此行为）
// VU-13：applyStatement 的对象命名参数已从「多层猜测式回退」改为
// 「一次规范化 + 一次执行」，真实 SQL 错误立即冒泡，不再被掩盖。

const test = require("node:test");
const assert = require("node:assert");
const { Database } = require("../src/utils/sqlite3Adapter");

test("all() 正常 SELECT 返回行", (t, done) => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t(a)", [], () => {
    db.run("INSERT INTO t(a) VALUES (1),(2)", [], () => {
      db.all("SELECT a FROM t ORDER BY a", [], (err, rows) => {
        try {
          assert.ifError(err);
          assert.deepStrictEqual(rows, [{ a: 1 }, { a: 2 }]);
        } finally {
          db.close(() => done());
        }
      });
    });
  });
});

test("get() 在表不存在时冒泡真实错误", (t, done) => {
  const db = new Database(":memory:");
  db.get("SELECT * FROM no_such_table", [], (err) => {
    try {
      assert.ok(err, "表不存在应冒泡 SQLITE_ERROR");
      assert.match(err.message, /no such table/i);
    } finally {
      db.close(() => done());
    }
  });
});

test("run() 绑定数量不匹配时冒泡错误而非被回退掩盖", (t, done) => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t(a, b)", [], () => {
    // SQL 需要 2 个参数却只给 1 个：真实错误应冒泡。
    db.run("INSERT INTO t(a, b) VALUES (?, ?)", [1], (err) => {
      try {
        assert.ok(err, "绑定数量不匹配应报错，而非被多路回退掩盖成成功");
      } finally {
        db.close(() => done());
      }
    });
  });
});

test("all() 对 DDL 保持兼容（Sequelize 依赖此行为）", (t, done) => {
  const db = new Database(":memory:");
  db.all("CREATE TABLE t(a)", [], (err) => {
    try {
      // DDL 经 all() 不应抛 "does not return data"，结果集为空。
      assert.ifError(err);
    } finally {
      db.close(() => done());
    }
  });
});

// VU-13：命名参数对象绑定路径——只做一次规范化 + 一次执行，
// 真实 SQL 错误（如列不存在）必须立即冒泡，不被多层猜测式回退掩盖。
test("命名参数对象绑定正常 + 真实错误冒泡（VU-13）", (t, done) => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t(a)", [], (createErr) => {
    assert.ifError(createErr);
    // :a 占位符需以无前缀 key 绑定（better-sqlite3 规则）。
    db.run("INSERT INTO t(a) VALUES (:a)", { a: 5 }, (insErr) => {
      assert.ifError(insErr);
      db.all("SELECT a FROM t WHERE a = :a", { a: 5 }, (selErr, rows) => {
        try {
          assert.ifError(selErr);
          assert.deepStrictEqual(rows, [{ a: 5 }]);

          // 真实错误：绑定的列不存在，应冒泡 SQLITE_ERROR，不被回退吞掉。
          db.run(
            "INSERT INTO t(nonexistent_col) VALUES (:x)",
            { x: 1 },
            (badErr) => {
              try {
                assert.ok(
                  badErr,
                  "列不存在应冒泡 SQLITE_ERROR，而非被多层回退掩盖成成功"
                );
                assert.match(badErr.message, /no such column/i);
              } finally {
                db.close(() => done());
              }
            }
          );
        } catch (e) {
          db.close(() => done(e));
        }
      });
    });
  });
});
