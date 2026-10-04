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
    db.run(`CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS challenges (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, text TEXT, target_username TEXT, status TEXT DEFAULT 'pending', assigned_to INTEGER DEFAULT NULL, assigned_at DATETIME DEFAULT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS daily_submissions (user_id INTEGER, type TEXT, submission_date TEXT, PRIMARY KEY (user_id, type, submission_date))`);
    console.log('✅ База данных готова');
});

// === ДИАГНОСТИКА ===
app.get('/api/debug-users', (req, res) => {
    db.all(`SELECT telegram_id, username, first_name FROM users`, [], (err, rows) => {
        if (err) return res.json({ error: err.message });
        res.json({ 
            message: "Список всех пользователей в базе данных",
            users: rows.map(u => ({
                id: u.telegram_id,
                raw_username: u.username,
                normalized: normalizeUsername(u.username),
                name: u.first_name
            }))
        });
    });
});

// === API ===
app.post('/api/user', (req, res) => {
    const { telegram_id, username, first_name, last_name } = req.body;
    const normalizedUsername = normalizeUsername(username);
    console.log(`💾 Регистрация: ID=${telegram_id}, Сырой username="${username}", Нормализованный="${normalizedUsername}"`);
    db.run(`INSERT OR REPLACE INTO users (telegram_id, username, first_name, last_name) VALUES (?, ?, ?, ?)`, 
        [telegram_id, normalizedUsername, first_name, last_name], (err) => {
            if (err) {
                console.error(`❌ Ошибка сохранения пользователя:`, err.message);
                res.status(500).json({ error: err.message });
            } else {
                res.json({ success: true });
            }
        });
});

app.get('/api/limits/:userId', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.all(`SELECT type FROM daily_submissions WHERE user_id = ? AND submission_date = ?`, [req.params.userId, today], (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json({ general: rows.some(r => r.type === 'general'), friend: rows.some(r => r.type === 'friend') });
    });
});

app.post('/api/challenge', (req, res) => {
    const { user_id, type, text, target_username } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const normalizedTarget = normalizeUsername(target_username);
    
    db.get(`SELECT 1 FROM daily_submissions WHERE user_id = ? AND type = ? AND submission_date = ?`, [user_id, type, today], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) return res.status(400).json({ error: 'Лимит исчерпан' });

        db.run(`INSERT INTO challenges (user_id, type, text, target_username, status) VALUES (?, ?, ?, ?, 'pending')`, 
            [user_id, type, text, normalizedTarget], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                const challengeId = this.lastID;
                sendToModeration(challengeId, text, user_id, target_username);
                db.run(`INSERT INTO daily_submissions (user_id, type, submission_date) VALUES (?, ?, ?)`, [user_id, type, today], (err) => {
                    if (err) res.status(500).json({ error: err.message });
                    else res.json({ success: true, challenge_id: challengeId });
                });
            });
    });
});

app.get('/api/available-challenges', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id обязателен' });
    db.all(`SELECT id, text, user_id FROM challenges WHERE status = 'approved' AND assigned_to IS NULL AND user_id != ? ORDER BY RANDOM()`, [Number(userId)], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length > 0) return res.json(rows);
        res.json([{ id: 999, text: 'Сделай 20 отжиманий прямо сейчас!', user_id: 0 }]);
    });
});

app.get('/api/friend-challenges/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get(`SELECT username FROM users WHERE telegram_id = ?`, [userId], (err, user) => {
        if (err || !user || !user.username) return res.json([]);
        db.all(`SELECT id, text, user_id, target_username FROM challenges WHERE status = 'approved' AND type = 'friend' AND LOWER(target_username) = LOWER(?) AND assigned_to IS NULL`, [user.username], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });
});

app.post('/api/accept-friend-challenge', (req, res) => {
    const { user_id, challenge_id } = req.body;
    const now = new Date().toISOString();
    db.run(`UPDATE challenges SET assigned_to = ?, assigned_at = ? WHERE id = ? AND assigned_to IS NULL`, [Number(user_id), now, Number(challenge_id)], function(err) {
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
    db.run(`UPDATE challenges SET assigned_to = ?, assigned_at = ? WHERE id = ? AND assigned_to IS NULL`, [Number(user_id), now, Number(challenge_id)], function(err) {
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
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    db.get(`SELECT * FROM challenges WHERE assigned_to = ? AND assigned_at > ? ORDER BY assigned_at DESC LIMIT 1`, [userId, yesterday.toISOString()], (err, row) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json(row || null);
    });
});

app.get('/api/has-spun/:userId', (req, res) => {
    const userId = req.params.userId;
    const today = new Date().toISOString().split('T')[0];
    db.get(`SELECT 1 FROM challenges WHERE assigned_to = ? AND assigned_at >= ? LIMIT 1`, [userId, today], (err, row) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json({ hasSpun: !!row });
    });
});

// === БОТ ===
bot.start((ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Друг';
    const username = ctx.from.username || '';
    const webAppUrl = process.env.RENDER_EXTERNAL_URL || 'https://privaje-bot.onrender.com';
    
    console.log(`📱 /start от пользователя: ID=${userId}, username="${username}", имя="${firstName}"`);
    
    // Сохраняем пользователя в БД при /start
    const normalizedUsername = normalizeUsername(username);
    db.run(`INSERT OR REPLACE INTO users (telegram_id, username, first_name, last_name) VALUES (?, ?, ?, ?)`, 
        [userId, normalizedUsername, firstName, ctx.from.last_name || ''], (err) => {
            if (err) console.error('Ошибка сохранения при /start:', err.message);
            else console.log(`✅ Пользователь ${userId} сохранён в БД с username="${normalizedUsername}"`);
        });
    
    ctx.reply(`👋 Привет, ${firstName}! Добро пожаловать в Privaje Challenges! 💜\n\nНажми кнопку ниже:`, 
        Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть челленджи', webAppUrl)]])
    );
});

// ✅ ОДОБРЕНИЕ С ПОДРОБНЫМИ ЛОГАМИ
bot.action(/^approve_(\d+)$/, (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Нет прав');
    const id = ctx.match[1];

    db.run(`UPDATE challenges SET status = 'approved' WHERE id = ?`, [id], function(err) {
        if (err) return ctx.reply('❌ Ошибка БД');

        db.get(`SELECT * FROM challenges WHERE id = ?`, [id], (err, ch) => {
            if (ch && ch.user_id !== ADMIN_ID) {
                if (ch.type === 'friend') {
                    console.log(`🎯 Одобрен дружеский челлендж #${id} для: "${ch.target_username}"`);
                    
                    // 1. Уведомляем создателя
                    bot.telegram.sendMessage(ch.user_id, `✅ Твой челлендж для @${ch.target_username} одобрен!\n\n"${ch.text}"\n\nМы уведомим друга, как только он зайдет в приложение. 💜`).catch(err => console.error('Ошибка отправки создателю:', err.message));

                    // 2. Пытаемся уведомить друга
                    if (ch.target_username) {
                        const normalizedTarget = normalizeUsername(ch.target_username);
                        console.log(` Ищем в БД пользователя с username: "${normalizedTarget}"`);
                        
                        db.get(`SELECT telegram_id, username FROM users WHERE LOWER(username) = ?`, [normalizedTarget], (err, friend) => {
                            if (err) {
                                console.error(`❌ Ошибка БД при поиске друга:`, err.message);
                            } else if (friend && friend.telegram_id) {
                                console.log(`✅ Друг найден! ID: ${friend.telegram_id}, Username: ${friend.username}`);
                                const webAppUrl = process.env.RENDER_EXTERNAL_URL || 'https://privaje-bot.onrender.com';
                                
                                const message = `🎁 У тебя новый челлендж от друга!\n\n"${ch.text}"\n\nОткрой приложение, чтобы принять его!`;
                                const keyboard = {
                                    inline_keyboard: [[{ text: ' Открыть приложение', web_app: { url: webAppUrl } }]]
                                };
                                
                                console.log(`📤 Пытаемся отправить сообщение другу ${friend.telegram_id}...`);
                                
                                bot.telegram.sendMessage(friend.telegram_id, message, { reply_markup: keyboard })
                                    .then(() => {
                                        console.log(`✅ Уведомление успешно отправлено другу ${friend.telegram_id}`);
                                    })
                                    .catch(err => {
                                        console.error(`❌ Ошибка отправки уведомления другу ${friend.telegram_id}:`);
                                        console.error(`   Код ошибки: ${err.error_code}`);
                                        console.error(`   Описание: ${err.description}`);
                                        console.error(`   Параметры:`, err.parameters);
                                        
                                        if (err.error_code === 403) {
                                            console.error(`💡 Причина: Пользователь заблокировал бота или никогда не начинал диалог (/start)`);
                                        } else if (err.error_code === 400) {
                                            console.error(`💡 Причина: Невозможно отправить сообщение этому пользователю`);
                                        }
                                    });
                            } else {
                                console.log(`⚠️ Друг с username "${normalizedTarget}" НЕ НАЙДЕН в базе данных`);
                                console.log(`💡 Подсказка: этот пользователь должен либо нажать /start в боте, либо открыть Web App хотя бы один раз.`);
                            }
                        });
                    }
                } else {
                    bot.telegram.sendMessage(ch.user_id, `✅ Твой челлендж одобрен!\n\n"${ch.text}"\n\nОн участвует в розыгрыше в 18:00 МСК! 🎲`).catch(err => console.error('Ошибка отправки:', err.message));
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
    const mskTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    const todayStr = mskTime.toISOString().split('T')[0];
    const hours = mskTime.getHours();
    const minutes = mskTime.getMinutes();

    if (hours === 18 && minutes === 0 && lastReminderDate !== todayStr) {
        lastReminderDate = todayStr;
        console.log(' Отправка напоминаний о розыгрыше (18:00 МСК)...');
        const today = new Date().toISOString().split('T')[0];
        const webAppUrl = process.env.RENDER_EXTERNAL_URL || 'https://privaje-bot.onrender.com';

        db.all(`SELECT DISTINCT ds.user_id FROM daily_submissions ds LEFT JOIN challenges c ON ds.user_id = c.assigned_to AND c.type = 'general' AND DATE(c.assigned_at) = DATE('now', 'localtime') WHERE ds.submission_date = ? AND ds.type = 'general' AND c.id IS NULL`, [today], (err, rows) => {
            if (err) return console.error('Ошибка поиска пользователей:', err.message);
            rows.forEach(row => {
                bot.telegram.sendMessage(row.user_id, `🎰 Время розыгрыша наступило!\n\nТы создавал челлендж сегодня, а значит можешь получить задание!\n\nОткрой приложение и крути колесо! 🎲`, {
                    reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть приложение', web_app: { url: webAppUrl } }]] }
                }).catch(err => console.log(`Не удалось отправить напоминание ${row.user_id}:`, err.message));
            });
            console.log(`✅ Напоминания отправлены ${rows.length} пользователям.`);
        });
    }
}, 60000);

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
bot.launch().catch(err => console.error('⚠️ Ошибка запуска бота:', err.message));
console.log('🤖 Бот запущен');

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(); });