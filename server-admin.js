const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.set('trust proxy', 1);

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(cors({
    origin: [
        'https://town-admin-production.up.railway.app',
        'https://t.me',
        'https://web.telegram.org'
    ]
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));
app.use('/api/', limiter);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345';

function logError(source, error, req = null) {
    console.error(`[ERROR][${source}]`, {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        ...(req && { body: req.body, url: req.url })
    });
}

function validateUserId(userId) {
    return userId && typeof userId === 'number' && userId > 0;
}

function validateString(value, maxLength = 255) {
    return value && typeof value === 'string' && value.length <= maxLength;
}

function validateNumber(value, min = 0, max = Infinity) {
    return typeof value === 'number' && value >= min && value <= max;
}

async function notifyUser(userId, message, buttons = null) {
    try {
        const BOT_TOKEN = process.env.BOT_TOKEN;
        if (!BOT_TOKEN) return false;
        
        const body = {
            chat_id: userId,
            text: message,
            parse_mode: 'HTML'
        };
        
        if (buttons && buttons.length > 0) {
            body.reply_markup = {
                inline_keyboard: buttons.map(row => row.map(btn => ({
                    text: btn.text,
                    url: btn.url || undefined,
                    callback_data: btn.callback_data || undefined
                })))
            };
        }
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return true;
    } catch (error) {
        console.error('[Notify] User error:', error);
        return false;
    }
}

async function notifyAdmin(message) {
    try {
        const adminId = process.env.ADMIN_CHAT_ID;
        if (!adminId) return;
        const BOT_TOKEN = process.env.BOT_TOKEN;
        if (!BOT_TOKEN) return;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: adminId,
                text: message,
                parse_mode: 'HTML'
            })
        });
    } catch (error) {
        console.error('[Notify] Admin error:', error);
    }
}

// ===== AUTH =====
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

// ===== STATS =====
app.post('/api/admin/stats', async (req, res) => {
    try {
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('id');
        
        if (usersError) throw usersError;
        
        const { data: transactions, error: txError } = await supabase
            .from('transactions')
            .select('amount, type, status')
            .eq('type', 'withdrawal')
            .eq('status', 'completed');
        
        if (txError) throw txError;
        
        const totalWithdrawals = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
        
        res.json({
            success: true,
            data: {
                totalUsers: users.length,
                totalWithdrawals: totalWithdrawals
            }
        });
    } catch (error) {
        logError('admin/stats', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== USERS =====
app.post('/api/admin/users/search', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { data, error } = await supabase
            .from('users')
            .select('id, first_name, username, gram_balance, games_balance, total_referrals, active_referrals, total_earnings, state')
            .eq('id', userId);
        if (error) throw error;
        res.json({ success: true, data: data[0] || null });
    } catch (error) {
        logError('admin/users/search', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/ban', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { error } = await supabase
            .from('users')
            .update({ state: 'ban' })
            .eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('admin/users/ban', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/unban', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { error } = await supabase
            .from('users')
            .update({ state: 'active' })
            .eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('admin/users/unban', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== TASKS =====
app.post('/api/admin/tasks/list', async (req, res) => {
    try {
        const { status, owner } = req.body;
        let query = supabase
            .from('user_tasks')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (status) query = query.eq('status', status);
        if (owner && validateUserId(owner)) query = query.eq('owner', owner);
        
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('admin/tasks/list', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/update-status', async (req, res) => {
    try {
        const { taskId, status } = req.body;
        if (!validateString(taskId, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        if (!['pending', 'active', 'rejected', 'completed'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }
        
        const { data: taskData, error: fetchError } = await supabase
            .from('user_tasks')
            .select('name, owner')
            .eq('id', taskId)
            .single();
        
        if (fetchError) throw fetchError;
        
        const { error } = await supabase
            .from('user_tasks')
            .update({ status: status })
            .eq('id', taskId);
        
        if (error) throw error;
        
        if (status === 'active' && taskData.owner && validateUserId(taskData.owner)) {
            await notifyUser(taskData.owner,
                `<b>✅ Task Approved</b>\n\n` +
                `<b>Task:</b> ${taskData.name}\n` +
                `<b>Status:</b> Active\n` +
                `<b>ℹ️ You can now complete this task.</b>`
            );
        } else if (status === 'rejected' && taskData.owner && validateUserId(taskData.owner)) {
            await notifyUser(taskData.owner,
                `<b>❌ Task Rejected</b>\n\n` +
                `<b>Task:</b> ${taskData.name}\n` +
                `<b>Status:</b> Rejected\n` +
                `<b>ℹ️ Please check the task requirements.</b>`
            );
        }
        
        res.json({ success: true });
    } catch (error) {
        logError('admin/tasks/update-status', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/delete', async (req, res) => {
    try {
        const { taskId } = req.body;
        if (!validateString(taskId, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        const { error } = await supabase
            .from('user_tasks')
            .delete()
            .eq('id', taskId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('admin/tasks/delete', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== WITHDRAWALS =====
app.post('/api/admin/withdrawals/list', async (req, res) => {
    try {
        const { status, userId } = req.body;
        let query = supabase
            .from('transactions')
            .select('*')
            .eq('type', 'withdrawal')
            .order('timestamp', { ascending: false });
        
        if (status) query = query.eq('status', status);
        if (userId && validateUserId(userId)) query = query.eq('user_id', userId);
        
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('admin/withdrawals/list', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/update-status', async (req, res) => {
    try {
        const { transactionId, status } = req.body;
        if (!validateString(transactionId, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid transaction ID' });
        }
        if (!['pending', 'completed', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }
        
        const { data: txData, error: fetchError } = await supabase
            .from('transactions')
            .select('user_id, amount')
            .eq('id', transactionId)
            .single();
        
        if (fetchError) throw fetchError;
        
        const { error } = await supabase
            .from('transactions')
            .update({ status: status })
            .eq('id', transactionId);
        
        if (error) throw error;
        
        if (status === 'completed') {
            await notifyUser(txData.user_id,
                `<b>✅ Withdrawal Approved!</b>\n\n` +
                `<b>💎 Amount:</b> ${txData.amount} GRAM\n` +
                `<b>ℹ️ You have received on @XRocket.</b>`
            );
            await notifyAdmin(
                `<b>💰 Withdrawal Completed</b>\n\n` +
                `<b>User:</b> ${txData.user_id}\n` +
                `<b>Amount:</b> ${txData.amount} GRAM`
            );
        } else if (status === 'rejected') {
            
        }
        
        res.json({ success: true });
    } catch (error) {
        logError('admin/withdrawals/update-status', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/delete', async (req, res) => {
    try {
        const { transactionId } = req.body;
        if (!validateString(transactionId, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid transaction ID' });
        }
        const { error } = await supabase
            .from('transactions')
            .delete()
            .eq('id', transactionId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('admin/withdrawals/delete', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== PROMO =====
app.post('/api/admin/promo/create', async (req, res) => {
    try {
        const { code, reward, rewardType, maxUses } = req.body;
        
        if (!validateString(code, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid promo code' });
        }
        if (!validateNumber(reward, 0.0001)) {
            return res.status(400).json({ success: false, error: 'Invalid reward amount' });
        }
        if (!['gram', 'games'].includes(rewardType)) {
            return res.status(400).json({ success: false, error: 'Invalid reward type' });
        }
        
        const promoData = {
            code: code.toUpperCase(),
            reward: reward,
            reward_type: rewardType,
            max_uses: maxUses || 999999,
            total: 0,
            created_at: Date.now()
        };
        
        const { data, error } = await supabase
            .from('promo_codes')
            .insert([promoData])
            .select();
        
        if (error) throw error;
        res.json({ success: true, data: data[0] });
    } catch (error) {
        logError('admin/promo/create', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/list', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('promo_codes')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('admin/promo/list', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/delete', async (req, res) => {
    try {
        const { code } = req.body;
        if (!validateString(code, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid promo code' });
        }
        
        const { error } = await supabase
            .from('promo_codes')
            .delete()
            .eq('code', code);
        
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('admin/promo/delete', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== NOTIFICATIONS =====
app.post('/api/admin/notifications/send', async (req, res) => {
    try {
        const { userId, message, buttons, target } = req.body;
        
        if (!validateString(message, 4096)) {
            return res.status(400).json({ success: false, error: 'Invalid message' });
        }
        
        let users = [];
        
        if (target === 'all') {
            const { data, error } = await supabase
                .from('users')
                .select('id')
                .eq('state', 'active');
            if (error) throw error;
            users = data.map(u => u.id);
        } else if (target === 'single' && validateUserId(userId)) {
            users = [userId];
        } else {
            return res.status(400).json({ success: false, error: 'Invalid target or user ID' });
        }
        
        let sent = 0;
        let failed = 0;
        const batchSize = 20;
        
        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);
            await Promise.all(batch.map(async (uid) => {
                try {
                    const success = await notifyUser(uid, message, buttons);
                    if (success) sent++;
                    else failed++;
                } catch (error) {
                    failed++;
                }
            }));
        }
        
        await notifyAdmin(
            `<b>📨 Notification Sent</b>\n\n` +
            `<b>Target:</b> ${target}\n` +
            `<b>Sent:</b> ${sent}\n` +
            `<b>Failed:</b> ${failed}`
        );
        
        res.json({ success: true, sent, failed });
    } catch (error) {
        logError('admin/notifications/send', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== HEALTH =====
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ===== STATIC =====
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'admin.html'));
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Admin Panel running on port ${PORT}`);
});
