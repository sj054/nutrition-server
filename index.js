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

app.post("/find-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "이메일을 입력하세요." });
  try {
    const [[user]] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (user)
      res.json({ success: true, message: "비밀번호 재설정 이메일이 전송되었습니다." });
    else res.status(404).json({ success: false, message: "가입되지 않은 이메일입니다." });
  } catch {
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

// ====================================================
// ✅ [카테고리 목록 / 전체 식단 조회]
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

// ====================================================
// ✅ [카테고리별 식단 조회] (meal_time 대응)
app.get("/meals/category/:id", async (req, res) => {
  const { id } = req.params;
  const { meal_time } = req.query;

  let sql = `
    SELECT 
      m.meal_id AS id,
      m.name,
      m.description,
      m.meal_time,
      m.image_url
    FROM meals AS m
    INNER JOIN meal_categories AS mc ON mc.meal_id = m.meal_id
    WHERE mc.category_id = ?
  `;
  const params = [id];

  if (meal_time) {
    sql += " AND m.meal_time COLLATE utf8mb4_general_ci = ?";
    params.push(meal_time);
  }

sql += " ORDER BY m.meal_id DESC";

  try {
    const [rows] = await pool.query(sql, params);
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(404).json({ message: "식단을 찾을 수 없습니다." });
    res.json(rows);
  } catch (err) {
    console.error("❌ /meals/category/:id 오류:", err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// ✅ [식단 상세 조회] — DB 구조 완전 일치
app.get("/meals/:id", async (req, res) => {
  const mealId = req.params.id;

  try {
    const [[mealInfo]] = await pool.query(
      `
      SELECT 
        meal_id,
        name,
        description,
        meal_time,
        image_url
      FROM meals
      WHERE meal_id = ?
      `,
      [mealId]
    );

    if (!mealInfo)
      return res.status(404).json({ message: "식단을 찾을 수 없습니다." });

    const [ingredients] = await pool.query(
      `
      SELECT ingredient, COALESCE(amount, '0') AS amount, unit
      FROM meal_ingredients
      WHERE meal_id = ?
      `,
      [mealId]
    );

    const [recipes] = await pool.query(
      `
      SELECT step_number, instruction
      FROM meal_recipes
      WHERE meal_id = ?
      ORDER BY step_number ASC
      `,
      [mealId]
    );

    res.json({
      id: mealInfo.meal_id,
      name: mealInfo.name,
      description: mealInfo.description,
      meal_time: mealInfo.meal_time,
      image_url: mealInfo.image_url,
      ingredients,
      recipes,
    });
  } catch (err) {
    console.error("❌ Meal detail query error:", err);
    res.status(500).json({ error: "Database query failed" });
  }
});

// ====================================================
// ✅ [오늘의 식단]
app.get("/meals/today", async (req, res) => {
  const time = req.query.time;
  try {
    const [rows] = await pool.query(
      "SELECT meal_id AS id, name, description, meal_time, image_url FROM meals WHERE LOWER(meal_time)=LOWER(?) ORDER BY RAND() LIMIT 3",
      [time]
    );
    if (rows.length === 0)
      return res.status(404).json({ message: "해당 시간대 식단이 없습니다." });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// ✅ [QnA 목록 조회]
app.get("/qna/list", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT q.id, q.user_id, u.nickname, q.question, q.answer, q.created_at FROM qna q LEFT JOIN users u ON u.id = q.user_id ORDER BY q.created_at DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ QnA 목록 오류:", err);
    res.status(500).json({ error: "서버 오류" });
  }
});

// ✅ [QnA 등록]
app.post("/qna/add", async (req, res) => {
  const { user_id, question } = req.body;
  if (!user_id || !question) {
    return res.status(400).json({ error: "user_id와 question은 필수입니다." });
  }
  try {
    await pool.query("INSERT INTO qna (user_id, question) VALUES (?, ?)", [user_id, question]);
    res.json({ success: true, message: "질문 등록 완료" });
  } catch (err) {
    console.error("❌ QnA 등록 오류:", err);
    res.status(500).json({ error: "서버 오류" });
  }
});


// ====================================================
// ✅ [사용자 프로필 조회]
app.get("/users/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const [rows] = await pool.query(
      "SELECT u.id, u.username, u.email, u.nickname, u.gender, u.category_id, c.name AS category_name FROM users u LEFT JOIN categories c ON c.id=u.category_id WHERE u.id=?",
      [id]
    );
    if (rows.length === 0)
      return res.status(404).json({ message: "사용자 없음" });

    const u = rows[0];
    const name = u.nickname || "";
    const displayName = u.username || u.nickname || (u.email ? u.email.split('@')[0] : "");
    const keyword = u.category_name || "";

    res.json({
      id: u.id,
      email: u.email || "",
      username: u.username || "",
      nickname: u.nickname || "",
      gender: u.gender || "",
      category_id: u.category_id || null,
      name,
      displayName,
      keyword,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ✅ 프로필 수정
app.patch("/users/:id", async (req, res) => {
  const userId = req.params.id;
  const { nickname, category_id, profileId } = req.body;

  try {
    // 동적으로 업데이트할 컬럼만 모아서 쿼리 만들기
    const fields = [];
    const values = [];

    if (nickname !== undefined) {
      fields.push("nickname = ?");
      values.push(nickname);
    }
    if (category_id !== undefined) {
      fields.push("category_id = ?");
      values.push(category_id);
    }
    if (profileId !== undefined) {
      fields.push("profile_image = ?");
      values.push(profileId);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: "업데이트할 필드가 없습니다." });
    }

    values.push(userId);

    const [result] = await pool.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "사용자 없음" });
    }

    // 수정된 사용자 다시 내려주기
    const [[user]] = await pool.query(
      "SELECT id, username, email, nickname, gender, category_id FROM users WHERE id = ?",
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
        INSERT IGNORE INTO challenge_results (user_challenge_id, meal_id, day_index, meal_time, status)
        SELECT cm.user_challenge_id, cm.meal_id, cm.day_index, cm.meal_time, '실패'
        FROM challenge_meals cm
        JOIN user_challenges uc ON uc.user_challenge_id=cm.user_challenge_id
        LEFT JOIN challenge_results cr
          ON cr.user_challenge_id=cm.user_challenge_id AND cr.day_index=cm.day_index AND cr.meal_time=cm.meal_time
        WHERE uc.status='진행 중' AND cr.id IS NULL
          AND DATE_ADD(DATE(uc.started_at), INTERVAL cm.day_index-1 DAY) < CURDATE()
      `);
    } catch (err) {
      console.error("[CRON] 자동 실패 에러:", err.message);
    }
  },
  { timezone: "Asia/Seoul" }
);

app.post('/challenge/week-result', (req, res) => {
    const { user_id, week_number, success_rate, most_successful_meal } = req.body;

    if (!user_id || !week_number) {
        return res.status(400).json({ message: "Missing user_id or week_number" });
    }

    // 성공 기준(80%)
    const is_success = success_rate >= 80 ? 1 : 0;

    // 1) user_week_success 저장
    const query1 = `
        INSERT INTO user_week_success 
        (user_id, week_number, success_rate, most_successful_meal, is_success, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
            success_rate = VALUES(success_rate),
            most_successful_meal = VALUES(most_successful_meal),
            is_success = VALUES(is_success),
            updated_at = NOW();
    `;

    db.query(query1, [user_id, week_number, success_rate, most_successful_meal, is_success], (err) => {
        if (err) {
            console.log(err);
            return res.status(500).json({ message: "DB Error (week save)" });
        }

        // 성공률 80% 미만 → 해금 없음
        if (!is_success) {
            return res.json({ message: "Week saved. No unlock." });
        }

        // 2) 성공한 주차 개수 가져오기 (스티커 개수와 동일)
        const countQuery = `
            SELECT COUNT(*) AS cnt
            FROM user_week_success
            WHERE user_id = ? AND is_success = 1;
        `;

        db.query(countQuery, [user_id], (err2, rows) => {
            if (err2) {
                console.log(err2);
                return res.status(500).json({ message: "DB Error (count)" });
            }

            const successCount = rows[0].cnt;

            // 스티커 목록 (순서대로 해금됨)
            const STICKERS = ["profile_1", "profile_2", "profile_3", "profile_4"];

            // successCount = 1 → profile_2
            const unlockSticker = STICKERS[successCount];

            if (!unlockSticker) {
                return res.json({ message: "All stickers already unlocked." });
            }

            // 3) 스티커 해금 (중복 방지: INSERT IGNORE)
            const insertStickerQuery = `
                INSERT IGNORE INTO user_stickers (user_id, sticker_code, unlocked_at)
                VALUES (?, ?, NOW());
            `;

            db.query(insertStickerQuery, [user_id, unlockSticker], (err3) => {
                if (err3) {
                    console.log(err3);
                    return res.status(500).json({ message: "DB Error (unlock sticker)" });
                }

                return res.json({
                    message: "Week saved + sticker unlocked",
                    unlocked: unlockSticker
                });
            });
        });
    });
});



// ====================================================
// ✅ 서버 실행
app.listen(port, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${port}`);
});