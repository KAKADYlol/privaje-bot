const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// Берем переменные из окружения (для хостинга) или используем значения по умолчанию
const BOT_TOKEN = process.env.BOT_TOKEN || '8794366768:AAHxVuiUOgFD0DSN9PZGQj2-LyA2uPdcw78';
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '7615268252');

const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('./privaje.db');

// === НАСТРОЙКА EXPRESS ===
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS challenges (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, text TEXT, target_username TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS daily_submissions (user_id INTEGER, type TEXT, submission_date TEXT, PRIMARY KEY (user_id, type, submission_date))`);
    console.log('✅ База данных готова');
});

app.post('/api/user', (req, res) => {
    const { telegram_id, username, first_name, last_name } = req.body;
    db.run(`INSERT OR REPLACE INTO users (telegram_id, username, first_name, last_name) VALUES (?, ?, ?, ?)`, 
        [telegram_id, username, first_name, last_name], (err) => {
            if (err) res.status(500).json({ error: err.message });
            else res.json({ success: true });
        });
});

app.get('/api/limits/:userId', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.all(`SELECT type FROM daily_submissions WHERE user_id = ? AND submission_date = ?`, [req.params.userId, today], (err, rows) => {
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
    
    db.get(`SELECT 1 FROM daily_submissions WHERE user_id = ? AND type = ? AND submission_date = ?`, [user_id, type, today], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) return res.status(400).json({ error: 'Лимит исчерпан' });

        db.run(`INSERT INTO challenges (user_id, type, text, target_username, status) VALUES (?, ?, ?, ?, 'pending')`, 
            [user_id, type, text, target_username], function(err) {
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

// === НАСТРОЙКА БОТА ===
bot.start((ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Друг';
    // Ссылка будет подставлена хостингом автоматически
    const webAppUrl = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` || 'https://твой-сайт.onrender.com';

    if (userId === ADMIN_ID) {
        ctx.reply(`👋 Привет, админ! Бот работает.\n🔗 Открыть Web App:`, Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть челленджи', webAppUrl)]]));
    } else {
        ctx.reply(`👋 Привет, ${firstName}! Добро пожаловать в Privaje Challenges! 💜\n\nНажми кнопку ниже, чтобы начать:`, Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть челленджи', webAppUrl)]]));
    }
});

bot.action(/^approve_(\d+)$/, async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Нет прав');
    const id = ctx.match[1];
    db.run(`UPDATE challenges SET status = 'approved' WHERE id = ?`, [id], () => {
        db.get(`SELECT * FROM challenges WHERE id = ?`, [id], (err, ch) => {
            if (ch && ch.user_id !== ADMIN_ID) {
                bot.telegram.sendMessage(ch.user_id, `✅ Твой челлендж одобрен!\n\n"${ch.text}"`);
            }
            ctx.editMessageText(`✅ *Одобрено:* "${ch?.text}"`, { parse_mode: 'Markdown' });
            ctx.answerCbQuery('Одобрено');
        });
    });
});

bot.action(/^reject_(\d+)$/, async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Нет прав');
    const id = ctx.match[1];
    db.run(`UPDATE challenges SET status = 'rejected' WHERE id = ?`, [id], () => {
        db.get(`SELECT * FROM challenges WHERE id = ?`, [id], (err, ch) => {
            if (ch && ch.user_id !== ADMIN_ID) {
                bot.telegram.sendMessage(ch.user_id, `❌ Твой челлендж отклонён.`);
            }
            ctx.editMessageText(`❌ *Отклонено:* "${ch?.text}"`, { parse_mode: 'Markdown' });
            ctx.answerCbQuery('Отклонено');
        });
    });
});

function sendToModeration(challengeId, text, userId, targetUsername) {
    let msg = `📝 *Новый челлендж!*\n🆔 ID: ${challengeId}\n👤 От: \`${userId}\`\n📄 "${text}"\n`;
    if (targetUsername) msg += `🎯 Для: ${targetUsername}\n`;
    
    bot.telegram.sendMessage(ADMIN_ID, msg, {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✅ Одобрить', `approve_${challengeId}`)],
            [Markup.button.callback('❌ Отклонить', `reject_${challengeId}`)]
        ]),
        parse_mode: 'Markdown'
    });
}

// === ЗАПУСК ВСЕГО ===
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
bot.launch();
console.log('🤖 Бот запущен');

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(); });