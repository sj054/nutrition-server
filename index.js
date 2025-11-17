// ====================================================
//  ✔ Nutrition Challenge Server (Render + MySQL)
//  ✔ 동작 보장 완성본
//  ✔ 주차 성공률 저장 + 스티커 해금
//  ✔ 스티커 목록 조회
// ====================================================

import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());
app.use(cors());

// ====================================================
// 1) MySQL 연결
// ====================================================
const pool = mysql.createPool({
  host: process.env.DATABASE_HOST,
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  port: process.env.DATABASE_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ====================================================
// 2) 기본 API (회원가입 / 로그인 / 카테고리 / 메뉴 등)
//    ※ 네가 기존에 작성했던 API 그대로 유지
// ====================================================

// ------- 예시: 로그인 -------
app.post("/users/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE email = ? AND password = ?",
      [email, password]
    );

    if (rows.length === 0) {
      return res.json({ success: false, message: "아이디 또는 비밀번호 오류" });
    }

    return res.json({
      success: true,
      message: "로그인 성공",
      user: rows[0],
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "서버 오류",
    });
  }
});

// ------- 예시: 회원가입 -------
app.post("/users/signup", async (req, res) => {
  const { username, email, password } = req.body;

  try {
    await pool.query(
      "INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
      [username, email, password]
    );

    return res.json({ success: true, message: "회원가입 성공" });
  } catch (err) {
    console.error("SIGNUP ERROR:", err);
    return res.json({
      success: false,
      message: "회원가입 실패",
    });
  }
});

// ====================================================
// ⭐ 3) 스티커 해금 시스템 핵심 구조 ⭐
// ====================================================

// ✔ 성공한 주차 수에 따라 해금되는 스티커 코드
//  - 1주차 성공 → sticker_2
//  - 2주차 성공 → sticker_3
//  - ...
const SUCCESS_STICKERS = [
  null,          // index 0 없음
  "sticker_2",   // 첫 성공
  "sticker_3",   // 두 번째 성공
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

// ====================================================
// ⭐ 3-1) 주차 결과 저장 + 스티커 해금 API
// ====================================================
app.post("/challenge/week-result", async (req, res) => {
  const { user_id, week_number, success_rate, most_successful_meal } = req.body;

  if (!user_id || !week_number || success_rate === undefined) {
    return res.status(400).json({
      success: false,
      message: "필수 데이터 부족",
    });
  }

  const userId = Number(user_id);
  const weekNum = Number(week_number);
  const rate = Number(success_rate);

  // ✔ 80% 이상이면 성공
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
      // 지금까지 성공한 주차 수 계산
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
          INSERT IGNORE INTO user_stickers (user_id, sticker_code, unlocked_at)
          VALUES (?, ?, NOW())
          `,
          [userId, unlockedSticker]
        );

        console.log(
          `[/challenge/week-result] 🎉 스티커 해금: user=${userId}, code=${unlockedSticker}`
        );
      }
    } else {
      console.log(`[/challenge/week-result] 이번 주 실패 → 스티커 해금 없음`);
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

// ====================================================
// ⭐ 3-2) 유저 스티커 목록 조회 API
// ====================================================
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
// 4) 서버 실행
// ====================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Server Running on port ${PORT}`);
});
