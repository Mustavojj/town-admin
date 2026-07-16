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

console.log('[Server] Starting with config:', {
    supabaseUrl: process.env.SUPABASE_URL ? 'Set' : 'Missing',
    supabaseKey: process.env.SUPABASE_SERVICE_KEY ? 'Set' : 'Missing',
    botToken: process.env.BOT_TOKEN ? 'Set' : 'Missing',
    xRocketKey: process.env.XROCKET_API_KEY ? 'Set' : 'Missing',
    adminChatId: process.env.ADMIN_CHAT_ID ? 'Set' : 'Missing'
});

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
        if (!BOT_TOKEN) {
            console.error('[Telegram] BOT_TOKEN not set');
            return false;
        }
        
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
        
        console.log('[Telegram] Sending to user:', userId);
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        const data = await response.json();
        if (!data.ok) {
            console.error('[Telegram] Error:', data);
            return false;
        }
        console.log('[Telegram] Sent successfully to:', userId);
        return true;
    } catch (error) {
        console.error('[Telegram] Error:', error);
        return false;
    }
}

async function notifyAdmin(message) {
    try {
        const adminId = process.env.ADMIN_CHAT_ID;
        if (!adminId) {
            console.warn('[Admin] ADMIN_CHAT_ID not set');
            return;
        }
        const BOT_TOKEN = process.env.BOT_TOKEN;
        if (!BOT_TOKEN) {
            console.warn('[Admin] BOT_TOKEN not set');
            return;
        }
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: adminId,
                text: message,
                parse_mode: 'HTML'
            })
        });
        console.log('[Admin] Notification sent');
    } catch (error) {
        console.error('[Admin] Error:', error);
    }
}

async function processXrocketTransfer(userId, amount, memo) {
    try {
        console.log('[xRocket] Processing transfer:', { userId, amount, memo });
        
        if (!process.env.XROCKET_API_KEY) {
            console.warn('[xRocket] API key missing, simulating success');
            return { success: true };
        }

        const absAmount = Math.abs(amount);
        
        const requestBody = {
            tgUserId: parseInt(userId),
            currency: 'TONCOIN',
            amount: parseFloat(absAmount.toFixed(5)),
            transferId: `${userId}_W`,
            description: 'GRAM TOWN Withdrawal'
        };
        
        console.log('[xRocket] Request body:', JSON.stringify(requestBody));
        
        const response = await fetch('https://pay.xrocket.exchange/app/transfer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Rocket-Pay-Key': process.env.XROCKET_API_KEY
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();
        console.log('[xRocket] Response status:', response.status);
        console.log('[xRocket] Response data:', JSON.stringify(data));

        if (data.success) {
            console.log('[xRocket] Transfer successful');
            return { success: true };
        } else {
            console.error('[xRocket] Transfer failed:', data);
            return { 
                success: false, 
                error: data.message || 'Transfer failed',
                details: data
            };
        }
    } catch (error) {
        console.error('[xRocket] Error:', error);
        return { success: false, error: error.message };
    }
}

app.post('/api/admin/login', (req, res) => {
    console.log('[Login] Attempt');
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        console.log('[Login] Success');
        res.json({ success: true });
    } else {
        console.log('[Login] Failed');
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

app.post('/api/admin/stats', async (req, res) => {
    try {
        console.log('[Stats] Fetching stats');
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('id');
        
        if (usersError) {
            console.error('[Stats] Users error:', usersError);
            throw usersError;
        }
        
        const { data: transactions, error: txError } = await supabase
            .from('transactions')
            .select('amount, type, status')
            .eq('type', 'withdrawal')
            .eq('status', 'completed');
        
        if (txError) {
            console.error('[Stats] Transactions error:', txError);
            throw txError;
        }
        
        const totalWithdrawals = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
        
        console.log('[Stats] Success:', { totalUsers: users.length, totalWithdrawals });
        res.json({
            success: true,
            data: {
                totalUsers: users.length,
                totalWithdrawals: parseFloat(totalWithdrawals.toFixed(5))
            }
        });
    } catch (error) {
        console.error('[Stats] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/search', async (req, res) => {
    try {
        const { userId } = req.body;
        console.log('[Users] Search:', { userId });
        
        let query = supabase
            .from('users')
            .select('id, first_name, username, gram_balance, games_balance, total_referrals, active_referrals, total_earnings, state');
        
        if (typeof userId === 'number' && userId > 0) {
            query = query.eq('id', userId);
        } else if (typeof userId === 'string' && userId.length > 0) {
            query = query.ilike('username', userId);
        } else {
            console.warn('[Users] Invalid userId:', userId);
            return res.status(400).json({ success: false, error: 'Invalid user ID or username' });
        }
        
        const { data, error } = await query;
        if (error) {
            console.error('[Users] Error:', error);
            throw error;
        }
        
        if (data && data[0]) {
            data[0].gram_balance = parseFloat((data[0].gram_balance || 0).toFixed(5));
            data[0].games_balance = parseFloat((data[0].games_balance || 0).toFixed(5));
            if (data[0].total_earnings) {
                data[0].total_earnings.gram = parseFloat((data[0].total_earnings.gram || 0).toFixed(5));
                data[0].total_earnings.games = parseFloat((data[0].total_earnings.games || 0).toFixed(5));
            }
        }
        
        console.log('[Users] Search result:', data ? 'Found' : 'Not found');
        res.json({ success: true, data: data[0] || null });
    } catch (error) {
        console.error('[Users] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/ban', async (req, res) => {
    try {
        const { userId } = req.body;
        console.log('[Users] Ban:', { userId });
        
        if (!validateUserId(userId)) {
            console.warn('[Users] Invalid userId:', userId);
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { error } = await supabase
            .from('users')
            .update({ state: 'ban' })
            .eq('id', userId);
        if (error) {
            console.error('[Users] Ban error:', error);
            throw error;
        }
        console.log('[Users] Ban success:', userId);
        res.json({ success: true });
    } catch (error) {
        console.error('[Users] Ban error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/unban', async (req, res) => {
    try {
        const { userId } = req.body;
        console.log('[Users] Unban:', { userId });
        
        if (!validateUserId(userId)) {
            console.warn('[Users] Invalid userId:', userId);
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { error } = await supabase
            .from('users')
            .update({ state: 'active' })
            .eq('id', userId);
        if (error) {
            console.error('[Users] Unban error:', error);
            throw error;
        }
        console.log('[Users] Unban success:', userId);
        res.json({ success: true });
    } catch (error) {
        console.error('[Users] Unban error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/create', async (req, res) => {
    try {
        const { name, url, description, category, rewardGram, rewardGames, maxCompletions, owner } = req.body;
        console.log('[Tasks] Create:', { name, url, description, category, rewardGram, rewardGames, maxCompletions, owner });
        
        if (!name || !url || !description) {
            console.warn('[Tasks] Missing required fields');
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
        
        if (error) {
            console.error('[Tasks] Create error:', error);
            throw error;
        }
        console.log('[Tasks] Create success:', data[0].id);
        res.json({ success: true, data: data[0] });
    } catch (error) {
        console.error('[Tasks] Create error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/list', async (req, res) => {
    try {
        const { status, owner, creator } = req.body;
        console.log('[Tasks] List:', { status, owner, creator });
        
        let query = supabase
            .from('user_tasks')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (status) query = query.eq('status', status);
        if (owner && validateUserId(owner)) query = query.eq('owner', owner);
        if (creator === 'admin') query = query.eq('owner', 0);
        if (creator === 'user') query = query.neq('owner', 0);
        
        const { data, error } = await query;
        if (error) {
            console.error('[Tasks] List error:', error);
            throw error;
        }
        
        if (data) {
            data.forEach(t => {
                t.reward_gram = parseFloat((t.reward_gram || 0).toFixed(5));
            });
        }
        
        console.log('[Tasks] List success:', data ? data.length : 0);
        res.json({ success: true, data });
    } catch (error) {
        console.error('[Tasks] List error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/get', async (req, res) => {
    try {
        const { taskId } = req.body;
        console.log('[Tasks] Get:', { taskId });
        
        if (!validateString(taskId, 50)) {
            console.warn('[Tasks] Invalid taskId:', taskId);
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        const { data, error } = await supabase
            .from('user_tasks')
            .select('*')
            .eq('id', taskId)
            .single();
        if (error) {
            console.error('[Tasks] Get error:', error);
            throw error;
        }
        
        if (data) {
            data.reward_gram = parseFloat((data.reward_gram || 0).toFixed(5));
        }
        
        console.log('[Tasks] Get success:', data ? 'Found' : 'Not found');
        res.json({ success: true, data });
    } catch (error) {
        console.error('[Tasks] Get error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/update', async (req, res) => {
    try {
        const { taskId, name, url, rewardGram, rewardGames } = req.body;
        console.log('[Tasks] Update:', { taskId, name, url, rewardGram, rewardGames });
        
        if (!validateString(taskId, 50)) {
            console.warn('[Tasks] Invalid taskId:', taskId);
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        if (!validateString(name, 50)) {
            console.warn('[Tasks] Invalid name:', name);
            return res.status(400).json({ success: false, error: 'Invalid task name' });
        }
        if (!validateString(url, 255)) {
            console.warn('[Tasks] Invalid url:', url);
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
        if (error) {
            console.error('[Tasks] Update error:', error);
            throw error;
        }
        console.log('[Tasks] Update success:', taskId);
        res.json({ success: true });
    } catch (error) {
        console.error('[Tasks] Update error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/update-status', async (req, res) => {
    try {
        const { taskId, status } = req.body;
        console.log('[Tasks] Update status:', { taskId, status });
        
        if (!validateString(taskId, 50)) {
            console.warn('[Tasks] Invalid taskId:', taskId);
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        if (!['pending', 'active', 'rejected', 'completed'].includes(status)) {
            console.warn('[Tasks] Invalid status:', status);
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }
        
        const { data: taskData, error: fetchError } = await supabase
            .from('user_tasks')
            .select('name, owner')
            .eq('id', taskId)
            .single();
        
        if (fetchError) {
            console.error('[Tasks] Fetch error:', fetchError);
            throw fetchError;
        }
        
        const { error } = await supabase
            .from('user_tasks')
            .update({ status: status })
            .eq('id', taskId);
        
        if (error) {
            console.error('[Tasks] Update error:', error);
            throw error;
        }
        
        if (status === 'active' && taskData.owner && validateUserId(taskData.owner)) {
            console.log('[Tasks] Notifying user:', taskData.owner);
            await notifyUser(taskData.owner,
                `<b>🎡 Your Task Approved!</b>\n\n` +
                `<b>◉ Task:</b> ${taskData.name}\n` +
                `<b>◉ Status:</b> Active\n` +
                `<b>♡ Thanks For Using GRAM TOWN!</b>`
            );
        }
        
        console.log('[Tasks] Update status success:', taskId);
        res.json({ success: true });
    } catch (error) {
        console.error('[Tasks] Update status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/delete', async (req, res) => {
    try {
        const { taskId } = req.body;
        console.log('[Tasks] Delete:', { taskId });
        
        if (!validateString(taskId, 50)) {
            console.warn('[Tasks] Invalid taskId:', taskId);
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        const { error } = await supabase
            .from('user_tasks')
            .delete()
            .eq('id', taskId);
        if (error) {
            console.error('[Tasks] Delete error:', error);
            throw error;
        }
        console.log('[Tasks] Delete success:', taskId);
        res.json({ success: true });
    } catch (error) {
        console.error('[Tasks] Delete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/list', async (req, res) => {
    try {
        const { status, userId } = req.body;
        console.log('[Withdrawals] List:', { status, userId });
        
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
        if (error) {
            console.error('[Withdrawals] List error:', error);
            throw error;
        }
        
        if (data) {
            data.forEach(w => {
                w.amount = parseFloat((w.amount || 0).toFixed(5));
            });
        }
        
        console.log('[Withdrawals] List success:', data ? data.length : 0);
        res.json({ success: true, data });
    } catch (error) {
        console.error('[Withdrawals] List error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/update-status', async (req, res) => {
    try {
        const { transactionId, status } = req.body;
        console.log('[Withdrawals] Update status:', { transactionId, status });
        
        if (!validateString(transactionId, 50)) {
            console.warn('[Withdrawals] Invalid transactionId:', transactionId);
            return res.status(400).json({ success: false, error: 'Invalid transaction ID' });
        }
        if (!['pending', 'completed', 'rejected'].includes(status)) {
            console.warn('[Withdrawals] Invalid status:', status);
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }
        
        const { data: txData, error: fetchError } = await supabase
            .from('transactions')
            .select('user_id, amount')
            .eq('id', transactionId)
            .single();
        
        if (fetchError) {
            console.error('[Withdrawals] Fetch error:', fetchError);
            throw fetchError;
        }
        
        console.log('[Withdrawals] Transaction data:', txData);
        
        if (status === 'completed') {
            console.log('[Withdrawals] Processing xRocket transfer for user:', txData.user_id);
            const transferResult = await processXrocketTransfer(txData.user_id, txData.amount, 'GRAM TOWN Withdrawal');
            
            if (!transferResult.success) {
                console.error('[Withdrawals] Transfer failed:', transferResult.error);
                return res.status(400).json({ 
                    success: false, 
                    error: 'Transfer failed: ' + (transferResult.error || 'Unknown error'),
                    details: transferResult.details || null
                });
            }
            
            console.log('[Withdrawals] Transfer successful');
            
            const { error } = await supabase
                .from('transactions')
                .update({ status: 'completed' })
                .eq('id', transactionId);
            
            if (error) {
                console.error('[Withdrawals] Update error:', error);
                throw error;
            }
            
            await notifyUser(txData.user_id,
                `<b>✅ Withdrawal Completed!</b>\n\n` +
                `<b>💎 Amount:</b> ${parseFloat(txData.amount.toFixed(5))} GRAM\n` +
                `<b>ℹ️ Check Your Funds on @XRocket</b>`
            );
            
            await notifyAdmin(
                `<b>💰 Withdrawal Completed</b>\n\n` +
                `<b>User:</b> ${txData.user_id}\n` +
                `<b>Amount:</b> ${parseFloat(txData.amount.toFixed(5))} GRAM`
            );
        } else {
            console.log('[Withdrawals] Updating status to:', status);
            const { error } = await supabase
                .from('transactions')
                .update({ status: status })
                .eq('id', transactionId);
            
            if (error) {
                console.error('[Withdrawals] Update error:', error);
                throw error;
            }
        }
        
        console.log('[Withdrawals] Update status success:', transactionId);
        res.json({ success: true });
    } catch (error) {
        console.error('[Withdrawals] Update status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/delete', async (req, res) => {
    try {
        const { transactionId } = req.body;
        console.log('[Withdrawals] Delete:', { transactionId });
        
        if (!validateString(transactionId, 50)) {
            console.warn('[Withdrawals] Invalid transactionId:', transactionId);
            return res.status(400).json({ success: false, error: 'Invalid transaction ID' });
        }
        const { error } = await supabase
            .from('transactions')
            .delete()
            .eq('id', transactionId);
        if (error) {
            console.error('[Withdrawals] Delete error:', error);
            throw error;
        }
        console.log('[Withdrawals] Delete success:', transactionId);
        res.json({ success: true });
    } catch (error) {
        console.error('[Withdrawals] Delete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/create', async (req, res) => {
    try {
        const { code, reward, rewardType, maxUses } = req.body;
        console.log('[Promo] Create:', { code, reward, rewardType, maxUses });
        
        if (!validateString(code, 50)) {
            console.warn('[Promo] Invalid code:', code);
            return res.status(400).json({ success: false, error: 'Invalid promo code' });
        }
        if (!validateNumber(reward, 0.0001)) {
            console.warn('[Promo] Invalid reward:', reward);
            return res.status(400).json({ success: false, error: 'Invalid reward amount' });
        }
        if (!['gram', 'games'].includes(rewardType)) {
            console.warn('[Promo] Invalid rewardType:', rewardType);
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
        
        if (error) {
            console.error('[Promo] Create error:', error);
            throw error;
        }
        console.log('[Promo] Create success:', data[0].code);
        res.json({ success: true, data: data[0] });
    } catch (error) {
        console.error('[Promo] Create error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/list', async (req, res) => {
    try {
        console.log('[Promo] List');
        const { data, error } = await supabase
            .from('promo_codes')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) {
            console.error('[Promo] List error:', error);
            throw error;
        }
        
        if (data) {
            data.forEach(p => {
                p.reward = parseFloat((p.reward || 0).toFixed(5));
            });
        }
        
        console.log('[Promo] List success:', data ? data.length : 0);
        res.json({ success: true, data });
    } catch (error) {
        console.error('[Promo] List error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/delete', async (req, res) => {
    try {
        const { code } = req.body;
        console.log('[Promo] Delete:', { code });
        
        if (!validateString(code, 50)) {
            console.warn('[Promo] Invalid code:', code);
            return res.status(400).json({ success: false, error: 'Invalid promo code' });
        }
        
        const { error } = await supabase
            .from('promo_codes')
            .delete()
            .eq('code', code);
        
        if (error) {
            console.error('[Promo] Delete error:', error);
            throw error;
        }
        console.log('[Promo] Delete success:', code);
        res.json({ success: true });
    } catch (error) {
        console.error('[Promo] Delete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/notifications/send', async (req, res) => {
    try {
        const { userId, message, buttons, target } = req.body;
        console.log('[Notifications] Send:', { userId, target, messageLength: message?.length, buttonsCount: buttons?.length });
        
        if (!validateString(message, 4096)) {
            console.warn('[Notifications] Invalid message');
            return res.status(400).json({ success: false, error: 'Invalid message' });
        }
        
        let users = [];
        
        if (target === 'all') {
            console.log('[Notifications] Getting all users');
            const { data, error } = await supabase
                .from('users')
                .select('id')
                .eq('state', 'active');
            if (error) {
                console.error('[Notifications] Fetch users error:', error);
                throw error;
            }
            users = data.map(u => u.id);
            console.log('[Notifications] Found', users.length, 'users');
        } else if (target === 'single' && validateUserId(userId)) {
            users = [userId];
            console.log('[Notifications] Single user:', userId);
        } else {
            console.warn('[Notifications] Invalid target or userId:', { target, userId });
            return res.status(400).json({ success: false, error: 'Invalid target or user ID' });
        }
        
        let sent = 0;
        let failed = 0;
        const batchSize = 20;
        
        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);
            console.log('[Notifications] Processing batch', i / batchSize + 1, 'of', Math.ceil(users.length / batchSize));
            await Promise.all(batch.map(async (uid) => {
                try {
                    const success = await notifyUser(uid, message, buttons);
                    if (success) sent++;
                    else failed++;
                } catch (error) {
                    console.error('[Notifications] Error for user', uid, ':', error);
                    failed++;
                }
            }));
        }
        
        console.log('[Notifications] Complete:', { sent, failed });
        
        await notifyAdmin(
            `<b>📨 Notification Sent</b>\n\n` +
            `<b>Target:</b> ${target}\n` +
            `<b>Sent:</b> ${sent}\n` +
            `<b>Failed:</b> ${failed}`
        );
        
        res.json({ success: true, sent, failed });
    } catch (error) {
        console.error('[Notifications] Error:', error);
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
