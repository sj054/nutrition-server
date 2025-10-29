/* ================================================
  Nutrition Challenge Server (v2025.10 - AutoFail Only)
  Node.js 18+ / MySQL 8+
  ✅ Render / Android 연동 완성 버전
  -----------------------------------------------
  - 회원가입 / 로그인 (bcrypt + JWT)
  - 동적 챌린지 생성 / 성공률 계산
  - 관리자 로그인 + 식단 추가 + 로그
  - BMI 기록 + 가이드 조회
  - CORS 전체 허용 / 정적 이미지 서빙
  - CRON: 자동 실패(5분)
================================================ */

const cron = require("node-cron");
const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// --------------------- DB 연결 ---------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  timezone: "+09:00",
  dateStrings: true,
});

// --------------------- 미들웨어 ---------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/images", express.static("public/images"));

// --------------------- 헬스 체크 ---------------------
app.get("/", (req, res) => res.send("🚀 서버 연결 성공!"));

// ====================================================
// ✅ [회원가입 API]
// ====================================================
app.post("/signup", async (req, res) => {
  const { email, password, nickname } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: "필수 항목 누락" });

  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (email, password, nickname, category_id) VALUES (?, ?, ?, 1)",
      [email, hash, nickname]
    );
    res.json({ success: true, message: "회원가입 완료" });
  } catch (err) {
    console.error("회원가입 오류:", err);
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});


// ====================================================
// ✅ [로그인 API] (category_id 포함 버전)
// ====================================================
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // ✅ DB에서 id, password, category_id까지 조회
    const [[user]] = await pool.query(
      "SELECT id AS user_id, email, password, category_id FROM users WHERE email = ?",
      [email]
    );

    if (!user)
      return res.status(401).json({ success: false, message: "존재하지 않는 사용자" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(401).json({ success: false, message: "비밀번호 불일치" });

    const token = jwt.sign(
      { user_id: user.user_id, email: user.email },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    // ✅ category_id 함께 반환
    res.json({
      success: true,
      token,
      user_id: user.user_id,
      category_id: user.category_id,
      message: "로그인 성공",
    });
  } catch (err) {
    console.error("로그인 오류:", err);
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

// ====================================================
// ✅ [1] 카테고리 / 식단 / 가이드
// ====================================================
app.get("/categories", async (_, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM categories");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/meals", async (_, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM meals");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/meals/category/:id", async (req, res) => {
  const { id } = req.params;
  const { meal_time } = req.query;
  let sql = `
    SELECT m.meal_id AS id, m.name, m.description, m.meal_time
    FROM meals m
    JOIN meal_categories mc ON mc.meal_id = m.meal_id
    WHERE mc.category_id = ?
  `;
  const params = [id];
  if (meal_time) {
    sql += " AND m.meal_time=?";
    params.push(meal_time);
  }
  try {
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/meals/:id", async (req, res) => {
  const mealId = req.params.id;
  try {
    const [[mealInfo]] = await pool.query(
      "SELECT meal_id, name, image_url, description, meal_time FROM meals WHERE meal_id = ?",
      [mealId]
    );
    if (!mealInfo) return res.status(404).json({ message: "식단을 찾을 수 없습니다." });

    const [ingredients] = await pool.query(
      `SELECT ingredient, COALESCE(amount, '0') AS amount, unit 
       FROM meal_ingredients WHERE meal_id = ?`,
      [mealId]
    );

    const [recipes] = await pool.query(
      "SELECT step_number, instruction FROM meal_recipes WHERE meal_id = ? ORDER BY step_number ASC",
      [mealId]
    );

    res.json({ ...mealInfo, ingredients, recipes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/category-guides/:categoryId", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, image_url FROM category_guides WHERE category_id=?",
      [req.params.categoryId]
    );
    if (!rows.length)
      return res.status(404).json({ message: "해당 카테고리의 가이드를 찾을 수 없습니다." });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// ✅ [NEW] 오늘의 식단 (아침/점심/저녁별 조회)
// ====================================================
app.get("/meals/today", async (req, res) => {
  const { time } = req.query; // breakfast / lunch / dinner

  try {
    // 오늘 날짜 기준 (기본적으로 meal_time 컬럼 기준)
    const [rows] = await pool.query(
      `
      SELECT 
        m.meal_id AS id,
        m.name,
        m.description,
        m.meal_time,
        m.image_url
      FROM meals m
      WHERE m.meal_time = ?
      ORDER BY RAND()
      LIMIT 3
      `,
      [time]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "해당 시간대 식단이 없습니다." });
    }

    res.json(rows);
  } catch (err) {
    console.error("❌ 오늘 식단 조회 오류:", err);
    res.status(500).json({ error: err.message });
  }
});


// ====================================================
// ✅ [2] 챌린지 생성 / 조회 / 결과
// ====================================================
app.post("/user-challenges", async (req, res) => {
  const { user_id, challenge_id } = req.body;
  try {
    const [[challenge]] = await pool.query(
      "SELECT category_id, day_count FROM challenges WHERE challenge_id=?",
      [challenge_id]
    );
    if (!challenge) return res.status(404).json({ message: "챌린지를 찾을 수 없습니다." });

    const [uc] = await pool.query(
      "INSERT INTO user_challenges (user_id, challenge_id, started_at, status) VALUES (?, ?, NOW(), '진행 중')",
      [user_id, challenge_id]
    );
    const ucId = uc.insertId;

    for (let day = 1; day <= challenge.day_count; day++) {
      let mealTimes = ["breakfast", "lunch", "dinner"];
      if (day === 1) {
        const h = new Date().getHours();
        if (h >= 10 && h < 15) mealTimes = ["lunch", "dinner"];
        else if (h >= 15) mealTimes = ["dinner"];
      }
      for (const t of mealTimes) {
        const [m] = await pool.query(
          `SELECT m.meal_id FROM meals m
           JOIN meal_categories mc ON mc.meal_id=m.meal_id
           WHERE mc.category_id=? AND m.meal_time=? ORDER BY RAND() LIMIT 1`,
          [challenge.category_id, t]
        );
        if (m.length)
          await pool.query(
            "INSERT INTO challenge_meals (user_challenge_id, challenge_id, meal_id, day_index, meal_time) VALUES (?,?,?,?,?)",
            [ucId, challenge_id, m[0].meal_id, day, t]
          );
      }
    }

    const [preview] = await pool.query(
      `SELECT cm.day_index, cm.meal_time, m.name AS meal_name, m.description AS meal_desc
       FROM challenge_meals cm JOIN meals m ON m.meal_id=cm.meal_id
       WHERE cm.user_challenge_id=? AND cm.day_index=1
       ORDER BY FIELD(cm.meal_time,'breakfast','lunch','dinner')`,
      [ucId]
    );

    res.json({ user_challenge_id: ucId, preview_day1: preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// ✅ [3] BMI 기록
// ====================================================
app.post("/weight-records", async (req, res) => {
  const { user_id, height_cm, weight_kg } = req.body;
  if (!user_id || !height_cm || !weight_kg)
    return res.status(400).json({ error: "user_id, height_cm, weight_kg 필수" });
  try {
    const [r] = await pool.query(
      "INSERT INTO weight_records (user_id, height_cm, weight_kg, recorded_at) VALUES (?, ?, ?, NOW())",
      [user_id, height_cm, weight_kg]
    );
    res.status(201).json({ ok: true, id: r.insertId, message: "체중이 기록되었습니다." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// ✅ [4] 관리자 기능
// ====================================================
function requireAdmin(requiredRole = "editor") {
  return (req, res, next) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "토큰 필요" });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.admin = payload;
      const roles = ["viewer", "editor", "super"];
      if (roles.indexOf(payload.role) < roles.indexOf(requiredRole))
        return res.status(403).json({ error: "권한 부족" });
      next();
    } catch {
      res.status(401).json({ error: "유효하지 않은 토큰" });
    }
  };
}

app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query("SELECT * FROM admin_users WHERE username=?", [username]);
    if (!rows.length) return res.status(401).json({ error: "존재하지 않는 계정" });
    const admin = rows[0];
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: "비밀번호 불일치" });

    const token = jwt.sign(
      { admin_id: admin.admin_id, username: admin.username, role: admin.role },
      JWT_SECRET,
      { expiresIn: "12h" }
    );
    res.json({ token, role: admin.role, name: admin.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/meals", requireAdmin("editor"), async (req, res) => {
  const { name, description, meal_time, category_ids, image_url } = req.body;
  if (!name || !meal_time || !Array.isArray(category_ids) || !category_ids.length)
    return res.status(400).json({ error: "필수값 누락" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [mealR] = await conn.query(
      "INSERT INTO meals (name, image_url, description, meal_time) VALUES (?,?,?,?)",
      [name, image_url ?? null, description ?? null, meal_time]
    );
    const mealId = mealR.insertId;
    const catVals = category_ids.map((c) => [mealId, c]);
    await conn.query("INSERT INTO meal_categories (meal_id, category_id) VALUES ?", [catVals]);
    await conn.commit();
    res.status(201).json({ ok: true, meal_id: mealId, message: "식단 추가 완료" });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ✅ [NEW] 사용자 프로필 조회
// GET /users/:id
app.get("/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // users + categories 조인해서 카테고리 이름을 keyword로 내려줌
    const [rows] = await pool.query(
      `
      SELECT 
        u.id,
        u.email,
        u.nickname,
        u.gender,
        u.category_id,
        c.name AS category_name
      FROM users u
      LEFT JOIN categories c ON c.id = u.category_id
      WHERE u.id = ?
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "사용자 없음" });
    }

    const u = rows[0];

    // Android UserProfile에 맞춘 파생 필드 구성
    const name = u.nickname || ""; // 앱에서 tv_name에 표시
    const displayName =
      u.nickname ||
      (u.email ? u.email.split("@")[0] : ""); // 앱 상단 textUsername
    const keyword = u.category_name || ""; // "선택한 식단" 칸에 표시

    // 최종 응답(JSON)
    res.json({
      id: u.id,
      email: u.email || "",
      nickname: u.nickname || "",
      gender: u.gender || "",
      category_id: u.category_id || null,
      // 앱에서 바로 쓰는 파생 필드들
      name,
      displayName,
      keyword,
    });
  } catch (error) {
    console.error("❌ 사용자 정보 조회 오류:", error);
    res.status(500).json({ error: error.message });
  }
});


// ====================================================
// ✅ [5] CRON — 자동 실패만 유지
// ====================================================
cron.schedule(
  "*/5 * * * *",
  async () => {
    console.log("[CRON] 자동 실패 처리 실행");
    try {
      await pool.query(`
        INSERT IGNORE INTO challenge_results (user_challenge_id, meal_id, day_index, meal_time, status)
        SELECT cm.user_challenge_id, cm.meal_id, cm.day_index, cm.meal_time, '실패'
        FROM challenge_meals cm
        JOIN user_challenges uc ON uc.user_challenge_id=cm.user_challenge_id
        LEFT JOIN challenge_results cr
          ON cr.user_challenge_id=cm.user_challenge_id AND cr.day_index=cm.day_index AND cr.meal_time=cm.meal_time
        WHERE uc.status='진행 중' AND cr.id IS NULL
          AND DATE_ADD(DATE(uc.started_at), INTERVAL cm.day_index-1 DAY) < CURDATE()
      `);
    } catch (e) {
      console.error("[CRON] 자동 실패 에러:", e.message);
    }
  },
  { timezone: "Asia/Seoul" }
);

// ✅ DB 연결 테스트용 (임시)
pool.query("SELECT * FROM test_table")
  .then(([rows]) => console.log("✅ DB 연결 성공:", rows))
  .catch((err) => console.error("❌ DB 연결 실패:", err.message));

// ====================================================
// ✅ [6] 서버 실행
// ====================================================
app.listen(port, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${port}`);
});
