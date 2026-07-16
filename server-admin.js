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
            const keyboard = buttons.map(btn => ({
                text: btn.text,
                url: btn.url || undefined,
                callback_data: btn.callback_data || undefined
            }));
            body.reply_markup = {
                inline_keyboard: [keyboard]
            };
        }
        
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        const data = await response.json();
        if (!data.ok) return false;
        return true;
    } catch (error) {
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
        return;
    }
}

async function processXrocketTransfer(userId, amount, memo) {
    try {
        if (!process.env.XROCKET_API_KEY) {
            return { success: true };
        }

        const absAmount = Math.abs(amount);
        const daten = Date.now();
        
        const requestBody = {
            tgUserId: parseInt(userId),
            currency: 'TONCOIN',
            amount: parseFloat(absAmount.toFixed(5)),
            transferId: `${daten}`,
            description: 'GRAM TOWN Withdrawal'
        };
        
        const response = await fetch('https://pay.xrocket.exchange/app/transfer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Rocket-Pay-Key': process.env.XROCKET_API_KEY
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        if (data.success) {
            return { success: true };
        } else {
            return { 
                success: false, 
                error: data.message || 'Transfer failed',
                details: data
            };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

app.post('/api/admin/stats', async (req, res) => {
    try {
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('id');
        
        if (usersError) throw usersError;
        
        const { data: transactions, error: txError } = await supabase
            .from('transactions')
            .select('amount')
            .eq('type', 'withdrawal')
            .eq('status', 'completed');
        
        if (txError) throw txError;
        
        const totalWithdrawals = transactions.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
        
        res.json({
            success: true,
            data: {
                totalUsers: users.length,
                totalWithdrawals: parseFloat(totalWithdrawals.toFixed(5))
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/search', async (req, res) => {
    try {
        const { userId } = req.body;
        let query = supabase
            .from('users')
            .select('id, first_name, username, gram_balance, games_balance, total_referrals, active_referrals, total_earnings, state');
        
        if (typeof userId === 'number' && userId > 0) {
            query = query.eq('id', userId);
        } else if (typeof userId === 'string' && userId.length > 0) {
            query = query.ilike('username', userId);
        } else {
            return res.status(400).json({ success: false, error: 'Invalid user ID or username' });
        }
        
        const { data, error } = await query;
        if (error) throw error;
        
        if (data && data[0]) {
            data[0].gram_balance = parseFloat((data[0].gram_balance || 0).toFixed(5));
            data[0].games_balance = parseFloat((data[0].games_balance || 0).toFixed(5));
            if (data[0].total_earnings) {
                data[0].total_earnings.gram = parseFloat((data[0].total_earnings.gram || 0).toFixed(5));
                data[0].total_earnings.games = parseFloat((data[0].total_earnings.games || 0).toFixed(5));
            }
        }
        
        res.json({ success: true, data: data[0] || null });
    } catch (error) {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/create', async (req, res) => {
    try {
        const { name, url, description, category, rewardGram, rewardGames, maxCompletions, owner } = req.body;
        
        if (!name || !url || !description) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        const taskData = {
            id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            name,
            url,
            description,
            category: category || 'social',
            reward_gram: parseFloat((rewardGram || 0.0001).toFixed(5)),
            reward_games: rewardGames || 1,
            max_completions: maxCompletions || 100,
            total: 0,
            status: 'active',
            owner: owner || 1891231976,
            created_at: Date.now()
        };
        
        const { data, error } = await supabase
            .from('user_tasks')
            .insert([taskData])
            .select();
        
        if (error) throw error;
        res.json({ success: true, data: data[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/list', async (req, res) => {
    try {
        const { status, owner, creator } = req.body;
        let query = supabase
            .from('user_tasks')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (status) query = query.eq('status', status);
        if (owner && validateUserId(owner)) query = query.eq('owner', owner);
        if (creator === 'admin') query = query.eq('owner', 0);
        if (creator === 'user') query = query.neq('owner', 0);
        
        const { data, error } = await query;
        if (error) throw error;
        
        if (data) {
            data.forEach(t => {
                t.reward_gram = parseFloat((t.reward_gram || 0).toFixed(5));
            });
        }
        
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/get', async (req, res) => {
    try {
        const { taskId } = req.body;
        if (!validateString(taskId, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        const { data, error } = await supabase
            .from('user_tasks')
            .select('*')
            .eq('id', taskId)
            .single();
        if (error) throw error;
        
        if (data) {
            data.reward_gram = parseFloat((data.reward_gram || 0).toFixed(5));
        }
        
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/update', async (req, res) => {
    try {
        const { taskId, name, url, rewardGram, rewardGames } = req.body;
        if (!validateString(taskId, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        if (!validateString(name, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid task name' });
        }
        if (!validateString(url, 255)) {
            return res.status(400).json({ success: false, error: 'Invalid task URL' });
        }
        
        const updateData = {
            name, 
            url
        };
        
        if (rewardGram !== undefined) {
            updateData.reward_gram = parseFloat(parseFloat(rewardGram).toFixed(5));
        }
        if (rewardGames !== undefined) {
            updateData.reward_games = parseInt(rewardGames);
        }
        
        const { error } = await supabase
            .from('user_tasks')
            .update(updateData)
            .eq('id', taskId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
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
                `<b>📋 Your Task Approved!</b>\n\n` +
                `<b>◉ Task:</b> ${taskData.name}\n` +
                `<b>◉ Status:</b> Active`
            );
        }
        
        res.json({ success: true });
    } catch (error) {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/list', async (req, res) => {
    try {
        const { status, userId } = req.body;
        let query = supabase
            .from('transactions')
            .select('*')
            .eq('type', 'withdrawal')
            .order('timestamp', { ascending: false });
        
        if (status) {
            query = query.eq('status', status);
        } else {
            query = query.eq('status', 'pending');
        }
        
        if (userId && validateUserId(userId)) {
            query = query.eq('user_id', userId);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        
        if (data) {
            data.forEach(w => {
                w.amount = -Math.abs(parseFloat((w.amount || 0).toFixed(5)));
            });
        }
        
        res.json({ success: true, data });
    } catch (error) {
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
        
        if (status === 'completed') {
            const transferResult = await processXrocketTransfer(txData.user_id, txData.amount, 'GRAM TOWN Withdrawal');
            
            if (!transferResult.success) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Transfer failed: ' + (transferResult.error || 'Unknown error'),
                    details: transferResult.details || null
                });
            }
            
            const absAmount = -Math.abs(txData.amount || 0);
            
            const { error } = await supabase
                .from('transactions')
                .update({ 
                    status: 'completed',
                    amount: parseFloat(absAmount.toFixed(5))
                })
                .eq('id', transactionId);
            
            if (error) throw error;
            
            await notifyUser(txData.user_id,
                `<b>✅ Withdrawal Completed!</b>\n\n` +
                `<b>💎 Amount:</b> ${parseFloat(Math.abs(txData.amount).toFixed(5))} GRAM\n` +
                `<b>ℹ️ Check Your Funds on @XRocket</b>`
            );
            
            await notifyAdmin(
                `<b>💰 Withdrawal Completed</b>\n\n` +
                `<b>User:</b> ${txData.user_id}\n` +
                `<b>Amount:</b> ${parseFloat(Math.abs(txData.amount).toFixed(5))} GRAM`
            );
        } else {
            const absAmount = -Math.abs(txData.amount || 0);
            
            const { error } = await supabase
                .from('transactions')
                .update({ 
                    status: status,
                    amount: parseFloat(absAmount.toFixed(5))
                })
                .eq('id', transactionId);
            
            if (error) throw error;
        }
        
        res.json({ success: true });
    } catch (error) {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

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
            reward: parseFloat(parseFloat(reward).toFixed(5)),
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
        
        if (data) {
            data.forEach(p => {
                p.reward = parseFloat((p.reward || 0).toFixed(5));
            });
        }
        
        res.json({ success: true, data });
    } catch (error) {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

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
            `<b>🔔 Notification Sent!</b>\n\n` +
            `<b>◉ Sent:</b> (${sent}/${target})\n` +
            `<b>◉ Failed:</b> ${failed}`
         );
        
        res.json({ success: true, sent, failed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'admin.html'));
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Admin Panel running on port ${PORT}`);
});
