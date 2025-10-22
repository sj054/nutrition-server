const mysql = require("mysql2/promise");

(async () => {
  const pool = await mysql.createPool({
    host: "localhost",
    user: "root",
    password: "sql1234",
    database: "nutrition_challenge"
  });
  const [rows] = await pool.query(
    "SELECT username, LENGTH(password_hash) AS len, password_hash FROM admin_users WHERE username='admin'"
  );
  console.log(rows);
  process.exit(0);
})();