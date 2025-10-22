/* ================================================
  -----------------------------------------------
  v2025.10 / Node.js 18+ / MySQL 8+
  - 사용자 챌린지 로직 (동적 시작 포함)
  - 관리자 로그인 + 식단 추가 + 로그
  - BMI 기록 + 가이드 조회
  - 시연용 CRON 주기 (자동 실패 5분, 최종 판정 1분)
================================================ */

const cron = require("node-cron");
const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs"); // bcryptjs 사용
const jwt = require("jsonwebtoken");
const cors = require("cors"); // cors 추가

const app = express();
const port = 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me"; // 실제 서비스에서는 환경변수로 관리!

// --------------------- DB 연결 ---------------------
const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "sql1234",
  database: "nutrition_challenge",
  timezone: "+09:00", // KST
  dateStrings: true, // DATETIME 문자열로 받기
});

app.use(cors()); // ✅ CORS 허용
app.use(express.json()); // POST body 파싱
app.use('/images', express.static('public/images')); // ✅ 이미지 폴더 서빙

// --------------------- 헬스 체크 ---------------------
app.get("/", (req, res) => res.send("🚀 서버 연결 성공!"));

// ====================================================
// ✅ [1] 카테고리 / 식단 / 가이드
// ====================================================
app.get("/categories", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM categories");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/meals", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM meals");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  if (meal_time) { sql += " AND m.meal_time=?"; params.push(meal_time); }
  try {
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ 식단 상세 조회 (재료 + 레시피 포함, ingredient 컬럼명 수정)
app.get("/meals/:id", async (req, res) => {
  const mealId = req.params.id;
  try {
    const [mealInfoRows] = await pool.query(
      "SELECT meal_id, name, image_url, description, meal_time FROM meals WHERE meal_id = ?",
      [mealId]
    );
    if (mealInfoRows.length === 0) {
      return res.status(404).json({ message: "식단을 찾을 수 없습니다." });
    }
    const mealInfo = mealInfoRows[0];

    // ...
const [ingredientsRows] = await pool.query(
  "SELECT ingredient, use_g AS amount, unit FROM meal_ingredients WHERE meal_id = ?", // ✅ use_g를 amount 별칭으로 사용
  [mealId]
);
// ...

    const [recipesRows] = await pool.query(
      "SELECT step_number, instruction FROM meal_recipes WHERE meal_id = ? ORDER BY step_number ASC",
      [mealId]
    );

    res.json({
      ...mealInfo,
      ingredients: ingredientsRows,
      recipes: recipesRows,
    });
  } catch (err) {
    console.error("식단 상세 조회 에러:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 라이프스타일 가이드 API
app.get("/category-guides/:categoryId", async (req, res) => {
  const { categoryId } = req.params;
  try {
    const [rows] = await pool.query(
      "SELECT id, image_url FROM category_guides WHERE category_id = ?",
      [categoryId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "해당 카테고리의 가이드를 찾을 수 없습니다." });
    }
    res.json(rows);
  } catch (err) {
    console.error("가이드 조회 에러:", err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// ✅ [2] 챌린지 생성 / 조회 / 결과 기록
// ====================================================

// ✅ 챌린지 생성 (1일차 동적 추천 적용)
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
    const user_challenge_id = uc.insertId;

    // 끼니 랜덤 배정 (1일차 동적 처리 포함)
    for (let day = 1; day <= challenge.day_count; day++) {
      let mealTimesToSchedule = ["breakfast", "lunch", "dinner"];
      if (day === 1) { // 1일차만 시간 체크
        const currentHour = new Date().getHours();
        if (currentHour >= 10 && currentHour < 15) mealTimesToSchedule = ["lunch", "dinner"];
        else if (currentHour >= 15) mealTimesToSchedule = ["dinner"];
      }

      for (const mealTime of mealTimesToSchedule) {
        const [meal] = await pool.query(
          `
          SELECT m.meal_id
          FROM meals m
          JOIN meal_categories mc ON mc.meal_id=m.meal_id
          WHERE mc.category_id=? AND m.meal_time=?
          ORDER BY RAND() LIMIT 1
          `,
          [challenge.category_id, mealTime]
        );
        if (meal.length) {
          await pool.query(
            `
            INSERT INTO challenge_meals (user_challenge_id, challenge_id, meal_id, day_index, meal_time)
            VALUES (?, ?, ?, ?, ?)
            `, // ON DUPLICATE KEY UPDATE 제거
            [user_challenge_id, challenge_id, meal[0].meal_id, day, mealTime]
          );
        }
      }
    }

    const [preview] = await pool.query(
      `
      SELECT cm.day_index, cm.meal_time, m.name AS meal_name, m.description AS meal_desc
      FROM challenge_meals cm
      JOIN meals m ON m.meal_id=cm.meal_id
      WHERE cm.user_challenge_id=? AND cm.day_index=1
      ORDER BY FIELD(cm.meal_time,'breakfast','lunch','dinner')
      `,
      [user_challenge_id]
    );

    res.json({ user_challenge_id, preview_day1: preview });
  } catch (err) {
    console.error("챌린지 생성 에러:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/challenges", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM challenges");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ 사용자 챌린지 조회 (성공률 분모 수정)
app.get("/user-challenges", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        uc.user_challenge_id, uc.user_id, uc.challenge_id,
        uc.started_at,
        uc.status,
        TRIM(REPLACE(REPLACE(c.title,'\\r',''),'\\n',' ')) AS challenge_title,
        c.day_count,
        ROUND((
          SELECT COUNT(*) FROM challenge_results cr
          WHERE cr.user_challenge_id=uc.user_challenge_id AND cr.status='성공'
        )/(
          -- 분모: 실제로 배정된 끼니 수
          SELECT COUNT(*) FROM challenge_meals cm WHERE cm.user_challenge_id = uc.user_challenge_id
        )*100) AS success_rate
      FROM user_challenges uc
      JOIN challenges c ON c.challenge_id=uc.challenge_id
      ORDER BY uc.user_challenge_id DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ 하루 3끼 조회 (image_url 포함)
app.get("/user-challenges/:ucId/days/:dayIndex", async (req, res) => {
  const { ucId, dayIndex } = req.params;
  try {
    const [rows] = await pool.query(`
      SELECT cm.day_index, cm.meal_time, m.meal_id, m.name, m.description, m.image_url
      FROM challenge_meals cm
      JOIN meals m ON m.meal_id=cm.meal_id
      WHERE cm.user_challenge_id=? AND cm.day_index=?
      ORDER BY FIELD(cm.meal_time,'breakfast','lunch','dinner')
    `, [ucId, dayIndex]);
    if (!rows.length) return res.status(404).json({ message: "데이터가 없습니다." });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 결과 기록 (UPSERT)
app.patch("/user-challenges/:ucId/results", async (req, res) => {
  const { ucId } = req.params;
  const { day_index, meal_time, status, rating, review, meal_id } = req.body;
  if (!day_index || !meal_time || !status || !meal_id)
    return res.status(400).json({ error: "day_index, meal_time, status, meal_id는 필수입니다." });

  try {
    await pool.query(`
      INSERT INTO challenge_results (user_challenge_id, meal_id, day_index, meal_time, status, rating, review)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status=VALUES(status), rating=VALUES(rating), review=VALUES(review),
        updated_at=CURRENT_TIMESTAMP
    `, [ucId, meal_id, day_index, meal_time, status, rating ?? null, review ?? null]);
    res.json({ ok: true, message: "결과가 저장되었습니다." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 결과 목록 (디버깅용)
app.get("/results", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT cr.*, m.name AS meal_name
      FROM challenge_results cr
      JOIN meals m ON m.meal_id=cr.meal_id
      ORDER BY cr.user_challenge_id, cr.day_index, FIELD(cr.meal_time,'breakfast','lunch','dinner')
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 포기
app.patch("/user-challenges/:ucId/cancel", async (req, res) => {
  try {
    const [r] = await pool.query(
      "UPDATE user_challenges SET status='포기' WHERE user_challenge_id=? AND status='진행 중'",
      [req.params.ucId]
    );
    if (!r.affectedRows) return res.status(400).json({ error: "이미 종료되었거나 존재하지 않는 챌린지입니다." });
    res.json({ ok: true, message: "챌린지가 중도 포기 처리되었습니다." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ====================================================
// ✅ [3] BMI 기록 API
// ====================================================
app.post("/weight-records", async (req, res) => {
  // 실제 앱에서는 JWT 토큰 등에서 user_id를 가져와야 함 (지금은 body에서 받음)
  const { user_id, height_cm, weight_kg } = req.body;
  if (!user_id || !height_cm || !weight_kg) {
    return res.status(400).json({ error: "user_id, height_cm, weight_kg는 필수입니다." });
  }
  try {
    const [result] = await pool.query(
      "INSERT INTO weight_records (user_id, height_cm, weight_kg, recorded_at) VALUES (?, ?, ?, NOW())",
      [user_id, height_cm, weight_kg]
    );
    const [[newRecord]] = await pool.query("SELECT *, DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s') AS recorded_at_kst FROM weight_records WHERE id = ?", [result.insertId]);
    res.status(201).json({ ok: true, record: newRecord, message: "체중이 기록되었습니다." });
  } catch (err) {
    console.error("BMI 기록 에러:", err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// ✅ [4] 관리자 기능
// ====================================================

// 관리자 인증 미들웨어 (JWT 토큰 검증)
function requireAdmin(requiredRole = 'editor') {
  return (req, res, next) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "인증 토큰이 필요합니다." });

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.admin = payload;

      if (payload.role !== 'super') {
        const roles = ['viewer', 'editor', 'super'];
        if (roles.indexOf(payload.role) < roles.indexOf(requiredRole)) {
          return res.status(403).json({ error: "권한이 부족합니다." });
        }
      }
      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') return res.status(401).json({ error: "토큰이 만료되었습니다." });
      res.status(401).json({ error: "유효하지 않은 토큰입니다." });
    }
  };
}

// 관리자 로그인 API
app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username, password 필수" });

  try {
    const [rows] = await pool.query("SELECT * FROM admin_users WHERE username=?", [username]);
    if (!rows.length) return res.status(401).json({ error: "존재하지 않는 관리자 계정입니다." });

    const admin = rows[0];
    const passwordMatch = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatch) return res.status(401).json({ error: "비밀번호가 일치하지 않습니다." });

    const tokenPayload = { admin_id: admin.admin_id, username: admin.username, role: admin.role };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: "12h" });

    await pool.query(
      "INSERT INTO admin_logs (admin_id, action_type, target_table, description) VALUES (?,?,?,?)",
      [admin.admin_id, "LOGIN", "admin_users", `관리자 ${admin.username} 로그인 성공`]
    );

    res.json({ token, role: admin.role, name: admin.name });
  } catch (err) {
    console.error("관리자 로그인 에러:", err);
    res.status(500).json({ error: err.message });
  }
});

// 새 식단 추가 API (관리자용, editor 이상 권한 필요)
app.post("/admin/meals", requireAdmin("editor"), async (req, res) => {
  const { name, description, meal_time, category_ids, image_url } = req.body;
  if (!name || !meal_time || !category_ids || !Array.isArray(category_ids) || category_ids.length === 0)
    return res.status(400).json({ error: "name, meal_time, category_ids(배열)는 필수입니다." });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [mealResult] = await conn.query(
      "INSERT INTO meals (name, image_url, description, meal_time) VALUES (?,?,?,?)",
      [name, image_url ?? null, description ?? null, meal_time]
    );
    const meal_id = mealResult.insertId;

    const categoryValues = category_ids.map(catId => [meal_id, catId]);
    if (categoryValues.length > 0) {
      await conn.query(
        "INSERT INTO meal_categories (meal_id, category_id) VALUES ?",
        [categoryValues]
      );
    }

    await conn.query(
      "INSERT INTO admin_logs (admin_id, action_type, target_table, target_id, description) VALUES (?,?,?,?,?)",
      [req.admin.admin_id, "INSERT", "meals", meal_id, `새 식단 '${name}' (${meal_time}) 추가 (카테고리: ${category_ids.join(',')})`]
    );

    await conn.commit();
    res.status(201).json({ ok: true, meal_id, message: "새 식단이 성공적으로 추가되었습니다." });

  } catch (err) {
    await conn.rollback();
    console.error("관리자 식단 추가 에러:", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ====================================================
// ✅ [5] CRON (자동 실패 / 최종 판정) - 시연용 설정
// ====================================================

// 자동 실패 (시연용 5분 주기)
cron.schedule("*/5 * * * *", async () => {
  console.log("[CRON] 자동 실패 처리 실행");
  try {
    const [r] = await pool.query(`
      INSERT IGNORE INTO challenge_results (user_challenge_id, meal_id, day_index, meal_time, status)
      SELECT cm.user_challenge_id, cm.meal_id, cm.day_index, cm.meal_time, '실패'
      FROM challenge_meals cm
      JOIN user_challenges uc ON uc.user_challenge_id = cm.user_challenge_id
      LEFT JOIN challenge_results cr
        ON cr.user_challenge_id = cm.user_challenge_id
       AND cr.day_index = cm.day_index
       AND cr.meal_time = cm.meal_time
      WHERE uc.status = '진행 중'
        AND cr.id IS NULL
        AND DATE_ADD(DATE(uc.started_at), INTERVAL cm.day_index - 1 DAY) < CURDATE()
    `);
    console.log(r.affectedRows > 0 ? `[CRON] 자동 실패 처리: ${r.affectedRows}건` : "[CRON] 자동 실패 처리: 대상 없음");
  } catch (e) { console.error("[CRON] 자동 실패 처리 에러:", e.message); }
}, { timezone: "Asia/Seoul" });

// 최종 판정 (시연용 1분 주기)
cron.schedule("*/1 * * * *", async () => {
  console.log("[CRON] 최종 판정 실행");
  try {
    const [r] = await pool.query(`
      UPDATE user_challenges uc
      JOIN challenges c ON c.challenge_id = uc.challenge_id
      JOIN (
        SELECT cr.user_challenge_id, COUNT(*) AS total_cnt, SUM(CASE WHEN cr.status = '실패' THEN 1 ELSE 0 END) AS fail_cnt
        FROM challenge_results cr
        GROUP BY cr.user_challenge_id
      ) s ON s.user_challenge_id = uc.user_challenge_id
      SET uc.status =
        CASE
          WHEN s.total_cnt >= c.day_count * 3
            THEN CASE WHEN s.fail_cnt > 0 THEN '실패' ELSE '성공' END
          ELSE uc.status
        END
      WHERE uc.status = '진행 중'
    `);
    if (r.affectedRows > 0) console.log(`[CRON] 최종 판정 업데이트 완료: ${r.affectedRows}건`);
    else console.log("[CRON] 최종 판정: 변경 없음");
  } catch (e) { console.error("[CRON] 최종 판정 에러:", e.message); }
}, { timezone: "Asia/Seoul" });

// ====================================================
// ✅ [6] 서버 실행
// ====================================================
app.listen(port, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${port}`);
});