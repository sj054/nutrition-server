/* ================================================
  Nutrition Challenge Server (v2025.10 - Final Stable)
  Node.js 18+ / MySQL 8+
  ✅ Render / Android Retrofit 연동 완성 버전
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
app.post("/signup", async (req, res) => {
  const { username, email, password, nickname, gender, category_id } = req.body;
  if (!username || !email || !password || !nickname || !gender || !category_id) {
    return res.status(400).json({
      success: false,
      message: "모든 필드(아이디, 이메일, 비번, 닉네임, 성별, 카테고리)는 필수입니다.",
    });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username, email, password, nickname, gender, category_id) VALUES (?, ?, ?, ?, ?, ?)",
      [username, email, hash, nickname, gender, category_id]
    );
    res.json({ success: true, message: "회원가입 완료" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const isUsernameDup = err.message.includes("'username'");
      const message = isUsernameDup ? "이미 사용 중인 아이디입니다." : "이미 사용 중인 이메일입니다.";
      return res.status(409).json({ success: false, message });
    }
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

// ====================================================
// ✅ [로그인 API]
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: "아이디와 비밀번호를 입력하세요." });

  try {
    const [[user]] = await pool.query(
      "SELECT id AS user_id, email, password, category_id, username FROM users WHERE username = ?",
      [username]
    );

    if (!user)
      return res.status(401).json({ success: false, message: "존재하지 않는 사용자" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(401).json({ success: false, message: "비밀번호 불일치" });

    const token = jwt.sign(
      { user_id: user.user_id, email: user.email, username: user.username },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      success: true,
      token,
      user_id: user.user_id,
      category_id: user.category_id,
      message: "로그인 성공",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

// ====================================================
// ✅ [ID/PW 찾기]
app.get("/find-id", async (req, res) => {
  const { name, email } = req.query;
  if (!name || !email)
    return res.status(400).json({ success: false, message: "이름과 이메일을 입력하세요." });

  try {
    const [[user]] = await pool.query(
      "SELECT username FROM users WHERE nickname = ? AND email = ?",
      [name, email]
    );
    if (user)
      res.json({ success: true, username: user.username });
    else res.status(404).json({ success: false, message: "일치하는 사용자가 없습니다." });
  } catch {
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

app.get("/find-password", async (req, res) => {
  const { username, email } = req.query;
  if (!username || !email)
    return res.status(400).json({ success: false, message: "아이디와 이메일을 입력하세요." });

  try {
    const [[user]] = await pool.query(
      "SELECT id FROM users WHERE username = ? AND email = ?",
      [username, email]
    );
    if (!user)
      return res.status(404).json({ success: false, message: "일치하는 사용자가 없습니다." });

    res.json({
      success: true,
      message: "비밀번호 재설정 링크를 이메일로 발송했다고 가정합니다. (실제 메일 기능 없음)",
    });
  } catch {
    res.status(500).json({ success: false, message: "서버 에러" });
  }
});

// ====================================================
// ✅ [프로필 조회]
app.get("/profile/:user_id", async (req, res) => {
  const userId = req.params.user_id;
  try {
    const [[user]] = await pool.query(
      `
      SELECT id, username, email, nickname, gender, birth, category_id, profile_image
      FROM users
      WHERE id = ?
      `,
      [userId]
    );

    if (!user)
      return res.status(404).json({ success: false, message: "사용자 정보를 찾을 수 없습니다." });

    res.json({ success: true, user });
  } catch (err) {
    console.error("[PROFILE GET ERROR]", err.message);
    res.status(500).json({ success: false, message: "서버 에러" });
  }
});

// ====================================================
// ✅ [프로필 수정]
app.patch("/profile/:user_id", async (req, res) => {
  const userId = req.params.user_id;
  const { nickname, gender, birth, category_id, profile_image } = req.body;

  try {
    await pool.query(
      `
      UPDATE users
      SET nickname = ?, gender = ?, birth = ?, category_id = ?, profile_image = ?
      WHERE id = ?
      `,
      [nickname || null, gender || null, birth || null, category_id || null, profile_image || null, userId]
    );

    res.json({ success: true, message: "프로필이 수정되었습니다." });
  } catch (err) {
    console.error("[PROFILE PATCH ERROR]", err.message);
    res.status(500).json({ success: false, message: "서버 에러" });
  }
});

// ====================================================
// ✅ [카테고리 목록]
app.get("/categories", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name, description FROM categories");
    res.json({ success: true, categories: rows });
  } catch (err) {
    console.error("[CATEGORIES ERROR]", err.message);
    res.status(500).json({ success: false, message: "서버 에러" });
  }
});

// ====================================================
// ✅ [식단 목록]
app.get("/meals", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM meals");
    res.json({ success: true, meals: rows });
  } catch (err) {
    console.error("[MEALS ERROR]", err.message);
    res.status(500).json({ success: false, message: "서버 에러" });
  }
});

// ✅ [식단 상세]
app.get("/meals/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const [[row]] = await pool.query("SELECT * FROM meals WHERE id = ?", [id]);
    if (!row)
      return res.status(404).json({ success: false, message: "해당 식단을 찾을 수 없습니다." });
    res.json({ success: true, meal: row });
  } catch (err) {
    console.error("[MEAL DETAIL ERROR]", err.message);
    res.status(500).json({ success: false, message: "서버 에러" });
  }
});

// ====================================================
// ✅ [유저 기본 정보(마이페이지 상단)]
app.get("/users/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const [rows] = await pool.query(
      `
      SELECT u.id, u.username, u.email, u.nickname, u.gender, u.birth, 
             u.category_id, u.profile_image, c.name AS category_name
      FROM users u
      LEFT JOIN categories c ON c.id = u.category_id
      WHERE u.id = ?
      `,
      [id]
    );

    if (rows.length === 0)
      return res.status(404).json({ message: "사용자 없음" });

    const u = rows[0];
    const name = u.nickname || "";
    const displayName =
      u.username || u.nickname || (u.email ? u.email.split("@")[0] : "");
    const keyword = u.category_name || "";

    res.json({
      user: {
        id: u.id,
        name,
        displayName,
        keyword,
        profile_image: u.profile_image,
      },
    });
  } catch (err) {
    console.error("[USER FETCH ERROR]", err.message);
    res.status(500).json({ message: "서버 에러" });
  }
});

// ====================================================
// ✅ [유저 프로필 수정(마이페이지)]
app.patch("/users/:id", async (req, res) => {
  const userId = req.params.id;
  const { nickname, gender, birth, category_id, profile_image } = req.body;

  try {
    const [result] = await pool.query(
      `
      UPDATE users
      SET nickname = ?, gender = ?, birth = ?, category_id = ?, profile_image = ?
      WHERE id = ?
      `,
      [nickname || null, gender || null, birth || null, category_id || null, profile_image || null, userId]
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "사용자 없음" });

    const [[user]] = await pool.query(
      `
      SELECT u.id, u.username, u.email, u.nickname, u.gender, u.birth, u.category_id,
             u.profile_image, c.name AS category_name
      FROM users u
      LEFT JOIN categories c ON c.id = u.category_id
      WHERE u.id = ?
      `,
      [userId]
    );

    res.json(user);
  } catch (err) {
    console.error("❌ /users/:id PATCH error:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});


// ====================================================
// ✅ [CRON - 자동 실패]
cron.schedule(
  "*/5 * * * *",
  async () => {
    console.log("[CRON] 자동 실패 처리 실행");
    try {
      await pool.query(`
        UPDATE user_challenges uc
        JOIN challenge_meals cm ON cm.user_challenge_id = uc.id
        LEFT JOIN challenge_results cr
          ON cr.user_challenge_id = uc.id
         AND cr.day_index = cm.day_index
         AND cr.meal_time = cm.meal_time
       SET uc.status='실패'
       WHERE uc.status='진행 중' AND cr.id IS NULL
         AND DATE_ADD(DATE(uc.started_at), INTERVAL cm.day_index-1 DAY) < CURDATE()
      `);
    } catch (err) {
      console.error("[CRON] 자동 실패 에러:", err.message);
    }
  },
  { timezone: "Asia/Seoul" }
);

// ====================================================
// ✅ 주간 결과 + 스티커 해금 API (추가 부분)
// ====================================================

// 성공 횟수 → 스티커 코드 매핑
// 1주차 성공 → sticker_2
// 2주차 성공 → sticker_3 ...
const SUCCESS_STICKERS = [
  null,          // 0 : 사용 안 함
  "sticker_2",   // 1회 성공
  "sticker_3",   // 2회 성공
  "sticker_4",
  "sticker_5",
  "sticker_6",
  "sticker_7",
  "sticker_8",
  "sticker_9",
  "sticker_10",
  "sticker_11",
  "sticker_12",
  "sticker_13",
  "sticker_14",
  "sticker_15",
  "sticker_16",
];

// ✅ 주간 결과 저장 + 스티커 해금
// Android: POST /challenge/week-result
// body: { user_id, week_number, success_rate, most_successful_meal }
app.post("/challenge/week-result", async (req, res) => {
  const { user_id, week_number, success_rate, most_successful_meal } = req.body;

  if (!user_id || !week_number || success_rate === undefined) {
    return res.status(400).json({
      success: false,
      message: "user_id, week_number, success_rate는 필수입니다.",
    });
  }

  const userId = Number(user_id);
  const weekNum = Number(week_number);
  const rate = Number(success_rate);

  // 🔥 80% 이상이면 성공
  const isSuccess = rate >= 80 ? 1 : 0;

  console.log(
    `[/challenge/week-result] ▶ user=${userId}, week=${weekNum}, rate=${rate}, isSuccess=${isSuccess}, most=${most_successful_meal}`
  );

  try {
    // 1) user_week_success 저장 (있으면 UPDATE)
    await pool.query(
      `
      INSERT INTO user_week_success
        (user_id, week_number, success_rate, most_successful_meal, is_success, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        success_rate = VALUES(success_rate),
        most_successful_meal = VALUES(most_successful_meal),
        is_success = VALUES(is_success),
        updated_at = NOW()
      `,
      [userId, weekNum, rate, most_successful_meal || null, isSuccess]
    );

    let unlockedSticker = null;

    // 2) 성공한 경우만 스티커 해금
    if (isSuccess === 1) {
      // 지금까지 성공한 주차 수
      const [rows] = await pool.query(
        `
        SELECT COUNT(*) AS cnt
        FROM user_week_success
        WHERE user_id = ? AND is_success = 1
        `,
        [userId]
      );

      const successCount = rows[0].cnt; // 첫 성공이면 1
      unlockedSticker = SUCCESS_STICKERS[successCount] || null;

      if (unlockedSticker) {
        await pool.query(
          `
          INSERT INTO user_stickers (user_id, sticker_code, unlocked_at)
          VALUES (?, ?, NOW())
          `,
          [userId, unlockedSticker]
        );

        console.log(
          `[/challenge/week-result] 🎉 스티커 해금: user=${userId}, code=${unlockedSticker}`
        );
      } else {
        console.log(
          `[/challenge/week-result] 성공 횟수=${successCount}, 추가 해금 스티커 없음`
        );
      }
    } else {
      console.log(
        `[/challenge/week-result] 이번 주 실패 (rate=${rate}) → 스티커 해금 없음`
      );
    }

    return res.json({
      success: true,
      message: "주차 결과 저장 완료",
      unlocked_sticker: unlockedSticker,
    });
  } catch (err) {
    console.error("[/challenge/week-result] ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "서버 오류",
      error: err.message,
    });
  }
});

// ✅ 유저 스티커 목록 조회
// Android: GET /stickers/:user_id
// 응답: { success: true, unlocked_stickers: ["sticker_2", ...] }
app.get("/stickers/:user_id", async (req, res) => {
  const userId = Number(req.params.user_id);

  try {
    const [rows] = await pool.query(
      `
      SELECT sticker_code
      FROM user_stickers
      WHERE user_id = ?
      ORDER BY unlocked_at ASC
      `,
      [userId]
    );

    const unlocked = rows.map((r) => r.sticker_code);

    console.log(
      `[/stickers] user=${userId} → unlocked = ${JSON.stringify(unlocked)}`
    );

    return res.json({
      success: true,
      unlocked_stickers: unlocked,
    });
  } catch (err) {
    console.error("[/stickers] ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "서버 오류",
      error: err.message,
    });
  }
});

// ====================================================
// ✅ 서버 실행
app.listen(port, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${port}`);
});
