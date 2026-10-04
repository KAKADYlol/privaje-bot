const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '8794366768:AAHxVuiUOgFD0DSN9PZGQj2-LyA2uPdcw78';
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '7615268252');

console.log('🔧 Конфигурация:');
console.log(`   BOT_TOKEN: ${BOT_TOKEN.substring(0, 20)}...`);
console.log(`   ADMIN_ID: ${ADMIN_ID}`);

const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('./privaje.db');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

function normalizeUsername(username) {
    if (!username) return null;
    return username.replace(/^@/, '').toLowerCase().trim();
}

// === БАЗА ДАННЫХ ===
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY, 
        username TEXT, 
        first_name TEXT, 
        last_name TEXT, 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_id INTEGER, 
        type TEXT, 
        text TEXT, 
        target_username TEXT, 
        status TEXT DEFAULT 'pending',
        assigned_to INTEGER DEFAULT NULL,
        assigned_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS daily_submissions (
        user_id INTEGER, 
        type TEXT, 
        submission_date TEXT, 
        PRIMARY KEY (user_id, type, submission_date)
    )`);
    console.log('✅ База данных готова');
});

// === API ===
app.post('/api/user', (req, res) => {
    const { telegram_id, username, first_name, last_name } = req.body;
    const normalizedUsername = normalizeUsername(username);
    db.run(`INSERT OR REPLACE INTO users (telegram_id, username, first_name, last_name) VALUES (?, ?, ?, ?)`, 
        [telegram_id, normalizedUsername, first_name, last_name], (err) => {
            if (err) res.status(500).json({ error: err.message });
            else res.json({ success: true });
        });
});

app.get('/api/limits/:userId', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.all(`SELECT type FROM daily_submissions WHERE user_id = ? AND submission_date = ?`, 
        [req.params.userId, today], (err, rows) => {
            if (err) res.status(500).json({ error: err.message });
            else res.json({ general: rows.some(r => r.type === 'general'), friend: rows.some(r => r.type === 'friend') });
        });
});

app.post('/api/challenge', (req, res) => {
    const { user_id, type, text, target_username } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const normalizedTarget = normalizeUsername(target_username);
    
    db.get(`SELECT 1 FROM daily_submissions WHERE user_id = ? AND type = ? AND submission_date = ?`, 
        [user_id, type, today], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (row) return res.status(400).json({ error: 'Лимит исчерпан' });

            db.run(`INSERT INTO challenges (user_id, type, text, target_username, status) VALUES (?, ?, ?, ?, 'pending')`, 
                [user_id, type, text, normalizedTarget], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    const challengeId = this.lastID;
                    sendToModeration(challengeId, text, user_id, target_username);
                    db.run(`INSERT INTO daily_submissions (user_id, type, submission_date) VALUES (?, ?, ?)`, 
                        [user_id, type, today], (err) => {
                            if (err) res.status(500).json({ error: err.message });
                            else res.json({ success: true, challenge_id: challengeId });
                        });
                });
        });
});

app.get('/api/available-challenges', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id обязателен' });
    
    db.all(`SELECT id, text, user_id FROM challenges WHERE status = 'approved' AND assigned_to IS NULL AND user_id != ? ORDER BY RANDOM()`, 
        [Number(userId)], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (rows.length > 0) return res.json(rows);
            
            res.json([
                { id: 999, text: 'Сделай 20 отжиманий прямо сейчас!', user_id: 0 },
                { id: 998, text: 'Напиши стихотворение про кота за 3 минуты', user_id: 0 }
            ]);
        });
});

app.get('/api/friend-challenges/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get(`SELECT username FROM users WHERE telegram_id = ?`, [userId], (err, user) => {
        if (err || !user || !user.username) return res.json([]);
        
        db.all(`SELECT id, text, user_id, target_username FROM challenges 
                WHERE status = 'approved' AND type = 'friend' 
                AND LOWER(target_username) = LOWER(?) AND assigned_to IS NULL`, 
            [user.username], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows);
            });
    });
});

app.post('/api/accept-friend-challenge', (req, res) => {
    const { user_id, challenge_id } = req.body;
    const now = new Date().toISOString();
    db.run(`UPDATE challenges SET assigned_to = ?, assigned_at = ? WHERE id = ? AND assigned_to IS NULL`, 
        [Number(user_id), now, Number(challenge_id)], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(400).json({ error: 'Челлендж уже принят' });
            
            db.get(`SELECT * FROM challenges WHERE id = ?`, [Number(challenge_id)], (err, challenge) => {
                if (err || !challenge) return res.status(500).json({ error: 'Челлендж не найден' });
                res.json({ success: true, challenge });
            });
        });
});

app.post('/api/assign-challenge', (req, res) => {
    const { user_id, challenge_id } = req.body;
    const now = new Date().toISOString();
    db.run(`UPDATE challenges SET assigned_to = ?, assigned_at = ? WHERE id = ? AND assigned_to IS NULL`, 
        [Number(user_id), now, Number(challenge_id)], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(400).json({ error: 'Челлендж уже выдан' });
            
            db.get(`SELECT * FROM challenges WHERE id = ?`, [Number(challenge_id)], (err, challenge) => {
                if (err || !challenge) return res.status(500).json({ error: 'Челлендж не найден' });
                res.json({ success: true, challenge });
            });
        });
});

app.get('/api/user-challenge/:userId', (req, res) => {
    const userId = req.params.userId;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    db.get(`SELECT * FROM challenges WHERE assigned_to = ? AND assigned_at > ? ORDER BY assigned_at DESC LIMIT 1`, 
        [userId, yesterday.toISOString()], (err, row) => {
            if (err) res.status(500).json({ error: err.message });
            else res.json(row || null);
        });
});

app.get('/api/has-spun/:userId', (req, res) => {
    const userId = req.params.userId;
    const today = new Date().toISOString().split('T')[0];
    db.get(`SELECT 1 FROM challenges WHERE assigned_to = ? AND assigned_at >= ? LIMIT 1`, 
        [userId, today], (err, row) => {
            if (err) res.status(500).json({ error: err.message });
            else res.json({ hasSpun: !!row });
        });
});

// === БОТ ===
bot.start((ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Друг';
    const webAppUrl = process.env.RENDER_EXTERNAL_URL || 'https://privaje-bot.onrender.com';
    ctx.reply(`👋 Привет, ${firstName}! Добро пожаловать в Privaje Challenges! 💜\n\nНажми кнопку ниже:`, 
        Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть челленджи', webAppUrl)]])
    );
});

// ✅ ИСПРАВЛЕННОЕ ОДОБРЕНИЕ
bot.action(/^approve_(\d+)$/, (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Нет прав');
    const id = ctx.match[1];

    db.run(`UPDATE challenges SET status = 'approved' WHERE id = ?`, [id], function(err) {
        if (err) return ctx.reply('❌ Ошибка БД');

        db.get(`SELECT * FROM challenges WHERE id = ?`, [id], (err, ch) => {
            if (ch && ch.user_id !== ADMIN_ID) {
                if (ch.type === 'friend') {
                    // 1. Уведомляем создателя
                    bot.telegram.sendMessage(ch.user_id, `✅ Твой челлендж для @${ch.target_username} одобрен!\n\n"${ch.text}"\n\nМы уведомим друга, как только он зайдет в приложение. 💜`).catch(() => {});

                    // 2. Уведомляем друга (если он есть в базе)
                    if (ch.target_username) {
                        const normalizedTarget = normalizeUsername(ch.target_username);
                        db.get(`SELECT telegram_id FROM users WHERE LOWER(username) = ?`, [normalizedTarget], (err, friend) => {
                            if (friend && friend.telegram_id) {
                                bot.telegram.sendMessage(friend.telegram_id, `🎁 У тебя новый челлендж от друга!\n\n"${ch.text}"\n\nОткрой приложение, чтобы принять его!`, {
                                    reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть приложение', web_app: { url: process.env.RENDER_EXTERNAL_URL || 'https://privaje-bot.onrender.com' } }]] }
                                }).catch(() => {});
                            }
                        });
                    }
                } else {
                    // Общий челлендж
                    bot.telegram.sendMessage(ch.user_id, `✅ Твой челлендж одобрен!\n\n"${ch.text}"\n\nОн участвует в розыгрыше в 18:00 МСК! 🎲`).catch(() => {});
                }
            }
            ctx.editMessageText(`✅ Одобрено: "${ch?.text || 'неизвестно'}"`).catch(() => {});
            ctx.answerCbQuery('Одобрено!');
        });
    });
});

bot.action(/^reject_(\d+)$/, (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Нет прав');
    const id = ctx.match[1];
    db.run(`UPDATE challenges SET status = 'rejected' WHERE id = ?`, [id], () => {
        db.get(`SELECT * FROM challenges WHERE id = ?`, [id], (err, ch) => {
            if (ch && ch.user_id !== ADMIN_ID) {
                bot.telegram.sendMessage(ch.user_id, `❌ Твой челлендж отклонён.\n\nПопробуй придумать другой!`).catch(() => {});
            }
            ctx.editMessageText(`❌ Отклонено: "${ch?.text || 'неизвестно'}"`).catch(() => {});
            ctx.answerCbQuery('Отклонено');
        });
    });
});

function sendToModeration(challengeId, text, userId, targetUsername) {
    let msg = `📝 Новый челлендж на модерацию!\n\n🆔 ID: ${challengeId}\n👤 От ID: ${userId}\n📄 Текст: "${text}"\n`;
    if (targetUsername) msg += `🎯 Для: ${targetUsername}\n`;
    msg += `\nНажми кнопку ниже:`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Одобрить', `approve_${challengeId}`)],
        [Markup.button.callback('❌ Отклонить', `reject_${challengeId}`)]
    ]);
    bot.telegram.sendMessage(ADMIN_ID, msg, keyboard).catch(err => console.error(`❌ Ошибка отправки: ${err.message}`));
}

// === НАПОМИНАНИЕ В 18:00 МСК ===
let lastReminderDate = '';

setInterval(() => {
    const now = new Date();
    const mskTime = new Date(now.getTime() + (3 * 60 * 60 * 1000)); // UTC+3
    const todayStr = mskTime.toISOString().split('T')[0];
    const hours = mskTime.getHours();
    const minutes = mskTime.getMinutes();

    // Срабатывает в 18:00 и проверяет флаг, чтобы не спамить
    if (hours === 18 && minutes === 0 && lastReminderDate !== todayStr) {
        lastReminderDate = todayStr;
        console.log('🕒 Отправка напоминаний о розыгрыше (18:00 МСК)...');

        const today = new Date().toISOString().split('T')[0];
        const webAppUrl = process.env.RENDER_EXTERNAL_URL || 'https://privaje-bot.onrender.com';

        // Ищем тех, кто создал общий челлендж сегодня, но еще не получил его (assigned_to IS NULL)
        db.all(`
            SELECT DISTINCT ds.user_id 
            FROM daily_submissions ds
            LEFT JOIN challenges c ON ds.user_id = c.assigned_to AND c.type = 'general' AND DATE(c.assigned_at) = DATE('now', 'localtime')
            WHERE ds.submission_date = ? AND ds.type = 'general' AND c.id IS NULL
        `, [today], (err, rows) => {
            if (err) {
                console.error('Ошибка поиска пользователей для напоминания:', err.message);
                return;
            }

            rows.forEach(row => {
                bot.telegram.sendMessage(row.user_id, 
                    `🎰 Время розыгрыша наступило!\n\nТы создавал челлендж сегодня, а значит можешь получить задание!\n\nОткрой приложение и крути колесо! 🎲`,
                    {
                        reply_markup: {
                            inline_keyboard: [[{ text: '🎮 Открыть приложение', web_app: { url: webAppUrl } }]]
                        }
                    }
                ).catch(err => console.log(`Не удалось отправить напоминание ${row.user_id}:`, err.message));
            });
            console.log(`✅ Напоминания отправлены ${rows.length} пользователям.`);
        });
    }
}, 60000); // Проверка каждую минуту

// === ЗАПУСК ===
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));

// Безопасный запуск бота с обработкой ошибок
bot.launch().catch(err => {
    console.error('⚠️ Ошибка запуска бота (сайт продолжит работать):', err.message);
});
console.log('🤖 Бот запущен');

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(); });