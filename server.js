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

console.log(' Конфигурация:');
console.log(`   BOT_TOKEN: ${BOT_TOKEN.substring(0, 20)}...`);
console.log(`   ADMIN_ID: ${ADMIN_ID}`);

const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('./privaje.db');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Функция нормализации username (убирает @ и приводит к lowercase)
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
    
    console.log(`👤 Регистрация пользователя: ${telegram_id}, username: ${normalizedUsername}`);
    
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
            else {
                res.json({ 
                    general: rows.some(r => r.type === 'general'), 
                    friend: rows.some(r => r.type === 'friend') 
                });
            }
        });
});

app.post('/api/challenge', (req, res) => {
    const { user_id, type, text, target_username } = req.body;
    const today = new Date().toISOString().split('T')[0];
    
    const normalizedTarget = normalizeUsername(target_username);
    console.log(`📝 Новый челлендж от ${user_id}: "${text}", target: ${normalizedTarget}`);
    
    db.get(`SELECT 1 FROM daily_submissions WHERE user_id = ? AND type = ? AND submission_date = ?`, 
        [user_id, type, today], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (row) return res.status(400).json({ error: 'Лимит исчерпан' });

            db.run(`INSERT INTO challenges (user_id, type, text, target_username, status) VALUES (?, ?, ?, ?, 'pending')`, 
                [user_id, type, text, normalizedTarget], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    const challengeId = this.lastID;
                    console.log(`✅ Челлендж #${challengeId} сохранён`);
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
    
    if (!userId) {
        return res.status(400).json({ error: 'user_id обязателен' });
    }
    
    db.all(`SELECT id, text, user_id FROM challenges WHERE status = 'approved' AND assigned_to IS NULL AND user_id != ? ORDER BY RANDOM()`, 
        [Number(userId)], (err, rows) => {
            if (err) {
                console.error('❌ Ошибка запроса:', err.message);
                return res.status(500).json({ error: err.message });
            }
            
            console.log(`📊 Найдено ${rows.length} челленджей для пользователя ${userId}`);
            
            if (rows.length > 0) {
                return res.json(rows);
            }
            
            console.log('⚠️ Нет челленджей, используем тестовые');
            res.json([
                { id: 999, text: 'Сделай 20 отжиманий прямо сейчас!', user_id: 0 },
                { id: 998, text: 'Напиши стихотворение про кота за 3 минуты', user_id: 0 },
                { id: 997, text: 'Позвони другу и расскажи анекдот', user_id: 0 }
            ]);
        });
});

// ИСПРАВЛЕННЫЙ ENDPOINT: Дружеские челленджи
app.get('/api/friend-challenges/:userId', (req, res) => {
    const userId = req.params.userId;
    
    console.log(`🔍 Запрос дружеских челленджей для пользователя ${userId}`);
    
    // Сначала получаем username пользователя
    db.get(`SELECT username FROM users WHERE telegram_id = ?`, [userId], (err, user) => {
        if (err) {
            console.error('Ошибка получения пользователя:', err.message);
            return res.status(500).json({ error: err.message });
        }
        
        if (!user || !user.username) {
            console.log(`⚠️ Пользователь ${userId} не найден или нет username`);
            return res.json([]);
        }
        
        console.log(`📧 Username пользователя: "${user.username}"`);
        
        // Ищем дружеские челленджи, адресованные этому пользователю
        db.all(`SELECT id, text, user_id, target_username FROM challenges 
                WHERE status = 'approved' AND type = 'friend' 
                AND LOWER(target_username) = LOWER(?) 
                AND assigned_to IS NULL`, 
            [user.username], (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка запроса friend-challenges:', err.message);
                    return res.status(500).json({ error: err.message });
                }
                
                console.log(`📦 Найдено ${rows.length} дружеских челленджей для ${user.username}`);
                rows.forEach(row => {
                    console.log(`   - Челлендж #${row.id}: "${row.text}" (target: ${row.target_username})`);
                });
                
                res.json(rows);
            });
    });
});

app.post('/api/accept-friend-challenge', (req, res) => {
    const { user_id, challenge_id } = req.body;
    const now = new Date().toISOString();
    
    console.log(`🎯 Принятие дружеского челленджа #${challenge_id} пользователем ${user_id}`);
    
    db.run(`UPDATE challenges SET assigned_to = ?, assigned_at = ? WHERE id = ? AND assigned_to IS NULL`, 
        [Number(user_id), now, Number(challenge_id)], function(err) {
            if (err) {
                console.error('❌ Ошибка принятия челленджа:', err.message);
                return res.status(500).json({ error: err.message });
            }
            
            if (this.changes === 0) {
                console.log('⚠️ Челлендж уже принят');
                return res.status(400).json({ error: 'Челлендж уже принят другим пользователем' });
            }
            
            db.get(`SELECT * FROM challenges WHERE id = ?`, [Number(challenge_id)], (err, challenge) => {
                if (err || !challenge) {
                    console.error('❌ Челлендж не найден после принятия');
                    return res.status(500).json({ error: 'Челлендж не найден' });
                }
                
                console.log(`✅ Челлендж #${challenge_id} успешно принят`);
                res.json({ success: true, challenge });
            });
        });
});

app.post('/api/assign-challenge', (req, res) => {
    const { user_id, challenge_id } = req.body;
    const now = new Date().toISOString();
    
    db.run(`UPDATE challenges SET assigned_to = ?, assigned_at = ? WHERE id = ? AND assigned_to IS NULL`, 
        [Number(user_id), now, Number(challenge_id)], function(err) {
            if (err) {
                console.error(' Ошибка обновления БД:', err.message);
                return res.status(500).json({ error: 'Ошибка базы данных: ' + err.message });
            }
            
            if (this.changes === 0) {
                return res.status(400).json({ error: 'Челлендж уже выдан другому или не существует' });
            }
            
            db.get(`SELECT * FROM challenges WHERE id = ?`, [Number(challenge_id)], (err, challenge) => {
                if (err || !challenge) {
                    return res.status(500).json({ error: 'Челлендж не найден после обновления' });
                }
                
                console.log(`✅ Челлендж #${challenge_id} назначен пользователю ${user_id}`);
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

// === DEBUG ENDPOINT ===
app.get('/api/debug', (req, res) => {
    db.all(`SELECT * FROM challenges ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.json({ error: err.message });
        
        const stats = {
            total: rows.length,
            pending: rows.filter(r => r.status === 'pending').length,
            approved: rows.filter(r => r.status === 'approved').length,
            rejected: rows.filter(r => r.status === 'rejected').length,
            assigned: rows.filter(r => r.assigned_to !== null).length,
            friend: rows.filter(r => r.type === 'friend').length
        };
        
        console.log('🔍 Debug stats:', stats);
        res.json({ stats, challenges: rows, users: [] });
    });
    
    db.all(`SELECT * FROM users`, [], (err, users) => {
        if (err) return;
        // Добавляем пользователей в ответ
    });
});

// === БОТ ===

bot.start((ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Друг';
    const webAppUrl = process.env.RENDER_EXTERNAL_URL || 'https://privaje-bot.onrender.com';

    if (userId === ADMIN_ID) {
        ctx.reply(
            `👋 Привет, админ! Бот модерации Privaje работает.\n\n🔗 Открыть Web App:`,
            Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть челленджи', webAppUrl)]])
        );
    } else {
        ctx.reply(
            `👋 Привет, ${firstName}! Добро пожаловать в Privaje Challenges! 💜\n\nНажми кнопку ниже, чтобы начать:`,
            Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть челленджи', webAppUrl)]])
        );
    }
});

bot.action(/^approve_(\d+)$/, async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Нет прав');
    const id = ctx.match[1];
    
    console.log(`✅ Админ одобрил челлендж #${id}`);
    
    db.run(`UPDATE challenges SET status = 'approved' WHERE id = ?`, [id], function(err) {
        if (err) {
            console.error('Ошибка одобрения:', err.message);
            return ctx.reply('❌ Ошибка БД');
        }
        
        console.log(`✅ Челлендж #${id} одобрен, changes: ${this.changes}`);
        
        db.get(`SELECT * FROM challenges WHERE id = ?`, [id], (err, ch) => {
            if (ch && ch.user_id !== ADMIN_ID) {
                bot.telegram.sendMessage(ch.user_id, `✅ Твой челлендж одобрен!\n\n"${ch.text}"\n\nОн участвует в розыгрыше в 18:00 МСК! 🎲`).catch(() => {});
            }
            ctx.editMessageText(`✅ Одобрено: "${ch?.text || 'неизвестно'}"`).catch(() => {});
            ctx.answerCbQuery('Одобрено!');
        });
    });
});

bot.action(/^reject_(\d+)$/, async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Нет прав');
    const id = ctx.match[1];
    
    console.log(`❌ Админ отклонил челлендж #${id}`);
    
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
    let msg = `📝 Новый челлендж на модерацию!\n\n`;
    msg += ` ID: ${challengeId}\n`;
    msg += `👤 От пользователя ID: ${userId}\n`;
    msg += `📄 Текст: "${text}"\n`;
    if (targetUsername) {
        msg += `🎯 Для пользователя: ${targetUsername}\n`;
    }
    msg += `\nНажми кнопку ниже:`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Одобрить', `approve_${challengeId}`)],
        [Markup.button.callback('❌ Отклонить', `reject_${challengeId}`)]
    ]);

    bot.telegram.sendMessage(ADMIN_ID, msg, keyboard).catch(err => {
        console.error(`❌ Ошибка отправки: ${err.message}`);
    });
}

// === ЗАПУСК ===
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
bot.launch();
console.log('🤖 Бот запущен');

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(); });