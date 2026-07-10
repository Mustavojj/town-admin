const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

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

console.log('🔍 Checking environment variables...');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing');
console.log('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? '✅ Set' : '❌ Missing');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? '✅ Set' : '❌ Missing');
console.log('ADMIN_IDS:', process.env.ADMIN_IDS || '❌ Missing');

console.log('📁 Checking required files...');
const requiredFiles = ['admin.html', 'css/admin.css', 'js/admin.js'];
for (const file of requiredFiles) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
        console.log(`✅ ${file} found`);
    } else {
        console.log(`❌ ${file} NOT found`);
    }
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const MINIMUM_WITHDRAW = 0.01;
const WITHDRAWAL_FEES = 0;
const TON_PRICE_PER_100 = 0.20;

const WITHDRAWAL_LIMITS = {
    maxPerRequest: 0.02,
    cooldownHours: 6,
    pendingThreshold: 0.02
};

const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];

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

async function isAdmin(userId) {
    if (!userId) return false;
    if (ADMIN_IDS.includes(userId)) return true;
    try {
        const { data, error } = await supabase
            .from('admins')
            .select('user_id')
            .eq('user_id', userId)
            .single();
        return !error && data !== null;
    } catch (error) {
        console.error('isAdmin error:', error.message);
        return false;
    }
}

async function logAdminAction(adminId, action, details = {}) {
    try {
        await supabase
            .from('admin_logs')
            .insert([{
                id: Date.now(),
                admin_id: adminId,
                action: action,
                details: details,
                timestamp: Date.now()
            }]);
    } catch (error) {
        console.error('Failed to log admin action:', error);
    }
}

async function sendNotification(userId, title, message) {
    try {
        const BOT_TOKEN = process.env.BOT_TOKEN;
        if (!BOT_TOKEN) {
            console.warn('BOT_TOKEN not set, skipping notification');
            return;
        }
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: userId,
                text: `*${title}*\n\n${message}`,
                parse_mode: 'Markdown'
            })
        });
    } catch (error) {
        console.error('Failed to send notification:', error);
    }
}

app.use(async (req, res, next) => {
    const userId = req.body.userId || req.query.userId || req.body.adminId;
    if (userId) {
        try {
            await supabase.rpc('set_config', {
                parameter: 'app.user_id',
                value: userId.toString(),
                is_local: true
            });
        } catch (error) {
            console.warn('Failed to set user_id config:', error.message);
        }
    }
    next();
});

async function adminAuth(req, res, next) {
    const adminId = req.body.adminId || req.query.adminId;
    if (!adminId || !(await isAdmin(adminId))) {
        return res.status(403).json({ success: false, error: 'Unauthorized: Admin access required' });
    }
    req.adminId = adminId;
    next();
}

app.post('/api/user/get', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId);
        if (error) throw error;
        if (data && data.length > 0) {
            res.json({ success: true, data: data[0] });
        } else {
            res.json({ success: false, error: 'User not found' });
        }
    } catch (error) {
        logError('user/get', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/create', async (req, res) => {
    try {
        const { userData } = req.body;
        if (!userData || !validateUserId(userData.id)) {
            return res.status(400).json({ success: false, error: 'Invalid user data' });
        }
        const { data, error } = await supabase
            .from('users')
            .insert([userData])
            .select();
        if (error) throw error;
        res.json({ success: true, data: data[0] });
    } catch (error) {
        logError('user/create', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/update', async (req, res) => {
    try {
        const { userId, data } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        if (!data || typeof data !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid data' });
        }
        const { error } = await supabase
            .from('users')
            .update(data)
            .eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('user/update', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/tasks/active', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('user_tasks')
            .select('*')
            .eq('status', 'active');
        if (error) throw error;
        const filteredTasks = data.filter(task => task.total < task.max_completions);
        res.json({ success: true, data: filteredTasks });
    } catch (error) {
        logError('tasks/active', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/tasks/create', async (req, res) => {
    try {
        const { taskData } = req.body;
        if (!taskData || !validateUserId(taskData.owner)) {
            return res.status(400).json({ success: false, error: 'Invalid task data' });
        }
        if (!validateString(taskData.name, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid task name' });
        }
        if (!validateNumber(taskData.max_completions, 1)) {
            return res.status(400).json({ success: false, error: 'Invalid max completions' });
        }

        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('gram_balance')
            .eq('id', taskData.owner)
            .single();

        if (userError || !userData) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const price = TON_PRICE_PER_100 * (taskData.max_completions / 100);
        if (userData.gram_balance < price) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }

        const newBalance = userData.gram_balance - price;

        await supabase
            .from('users')
            .update({ gram_balance: newBalance })
            .eq('id', taskData.owner);

        await supabase
            .from('balance_log')
            .insert([{
                id: Date.now(),
                user_id: taskData.owner,
                amount: -price,
                new_balance: newBalance,
                source: 'task_payment',
                reference_id: `task_payment_${taskData.id}`,
                timestamp: Date.now()
            }]);

        const { data, error } = await supabase
            .from('user_tasks')
            .insert([taskData])
            .select();

        if (error) throw error;
        res.json({ success: true, data: data[0] });
    } catch (error) {
        logError('tasks/create', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/tasks/user', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { data, error } = await supabase
            .from('user_tasks')
            .select('*')
            .eq('owner', userId);
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('tasks/user', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/tasks/complete', async (req, res) => {
    try {
        const { userId, taskId, completedAt } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        if (!validateString(taskId, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        const { error } = await supabase
            .from('completed_social_tasks')
            .insert([{ user_id: userId, task_id: taskId, completed_at: completedAt }]);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('tasks/complete', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/tasks/completed', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { data, error } = await supabase
            .from('completed_social_tasks')
            .select('*')
            .eq('user_id', userId);
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('tasks/completed', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/transactions/add', async (req, res) => {
    try {
        const { transaction } = req.body;
        if (!transaction || !validateUserId(transaction.user_id)) {
            return res.status(400).json({ success: false, error: 'Invalid transaction data' });
        }
        const { data, error } = await supabase
            .from('transactions')
            .insert([transaction])
            .select();
        if (error) throw error;
        res.json({ success: true, data: data[0] });
    } catch (error) {
        logError('transactions/add', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/transactions/get', async (req, res) => {
    try {
        const { userId, type, limit = 50 } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        let query = supabase
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .order('timestamp', { ascending: false })
            .limit(Math.min(limit, 100));
        if (type) query = query.eq('type', type);
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('transactions/get', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/promo/apply', async (req, res) => {
    try {
        const { code, userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        if (!validateString(code, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid promo code' });
        }
        const { data: promoData, error: promoError } = await supabase
            .from('promo_codes')
            .select('*')
            .eq('code', code);
        if (promoError || !promoData || promoData.length === 0) {
            return res.json({ success: false, error: 'Invalid code' });
        }
        const promo = promoData[0];
        const { data: usedData, error: usedError } = await supabase
            .from('used_promo_codes')
            .select('*')
            .eq('user_id', userId)
            .eq('code', code);
        if (usedData && usedData.length > 0) {
            return res.json({ success: false, error: 'Already used' });
        }
        if (promo.max_uses && promo.total >= promo.max_uses) {
            return res.json({ success: false, error: 'Expired' });
        }
        await supabase
            .from('used_promo_codes')
            .insert([{ user_id: userId, code: code }]);
        await supabase
            .from('promo_codes')
            .update({ total: (promo.total || 0) + 1 })
            .eq('code', code);
        res.json({ success: true, reward: promo.reward, type: promo.reward_type });
    } catch (error) {
        logError('promo/apply', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/bot/check-channel', async (req, res) => {
    try {
        const { channel, userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        if (!validateString(channel, 100)) {
            return res.status(400).json({ success: false, error: 'Invalid channel' });
        }
        const BOT_TOKEN = process.env.BOT_TOKEN;
        if (!BOT_TOKEN) {
            return res.json({ isMember: true, error: 'bot_token_missing' });
        }
        const botMe = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
        const botData = await botMe.json();
        const botId = botData.result.id;
        const botMember = await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${botId}`
        );
        const botMemberData = await botMember.json();
        const isBotAdmin = ['administrator', 'creator'].includes(botMemberData.result?.status);
        if (!isBotAdmin) {
            return res.json({ isMember: false, error: 'bot_not_admin' });
        }
        const response = await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${userId}`
        );
        const data = await response.json();
        const isMember = ['member', 'administrator', 'creator'].includes(data.result?.status);
        res.json({ isMember });
    } catch (error) {
        logError('bot/check-channel', error, req);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bot/check-admin', async (req, res) => {
    try {
        const { taskUrl } = req.body;
        if (!validateString(taskUrl, 255)) {
            return res.status(400).json({ success: false, error: 'Invalid task URL' });
        }
        const BOT_TOKEN = process.env.BOT_TOKEN;
        if (!BOT_TOKEN) {
            return res.json({ isAdmin: false, error: 'bot_token_missing' });
        }
        const chatId = taskUrl.match(/t\.me\/([^\/\?]+)/)?.[1];
        if (!chatId) {
            return res.json({ isAdmin: false, error: 'Invalid channel URL' });
        }
        const botMe = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
        const botData = await botMe.json();
        const botId = botData.result.id;
        const botMember = await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${chatId}&user_id=${botId}`
        );
        const botMemberData = await botMember.json();
        const isBotAdmin = ['administrator', 'creator'].includes(botMemberData.result?.status);
        res.json({ isAdmin: isBotAdmin, chatId });
    } catch (error) {
        logError('bot/check-admin', error, req);
        res.status(500).json({ isAdmin: false, error: error.message });
    }
});

app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount } = req.body;
    if (!validateUserId(userId)) {
        return res.status(400).json({ error: 'Invalid user' });
    }
    if (!validateNumber(amount, 0.0001)) {
        return res.status(400).json({ error: 'Invalid amount' });
    }

    try {
        const { data: lastWithdrawal } = await supabase
            .from('transactions')
            .select('timestamp')
            .eq('user_id', userId)
            .eq('type', 'withdrawal')
            .order('timestamp', { ascending: false })
            .limit(1);

        if (lastWithdrawal && lastWithdrawal.length > 0) {
            const lastTime = lastWithdrawal[0].timestamp;
            const cooldownMs = WITHDRAWAL_LIMITS.cooldownHours * 60 * 60 * 1000;
            if (Date.now() - lastTime < cooldownMs) {
                return res.status(400).json({
                    error: `Please wait ${WITHDRAWAL_LIMITS.cooldownHours} hours between withdrawals`
                });
            }
        }

        if (amount > WITHDRAWAL_LIMITS.maxPerRequest) {
            const status = 'pending';
            await addWithdrawalTransaction(userId, amount, 'xrocket', status);
            await sendNotification(
                process.env.ADMIN_CHAT_ID || userId,
                '⚠️ Pending Withdrawal Request',
                `User ID: ${userId}\nAmount: ${amount} GRAM\nStatus: Pending (exceeds max per request)`
            );
            await sendNotification(
                userId,
                'Withdrawal Pending',
                `Your withdrawal request of ${amount} GRAM has been sent for admin approval.`
            );
            return res.json({
                success: true,
                status: 'pending',
                message: 'Withdrawal sent for admin approval'
            });
        }

        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('gram_balance')
            .eq('id', userId)
            .single();

        if (userError || !userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        const totalRequired = amount + WITHDRAWAL_FEES;
        if (userData.gram_balance < totalRequired) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        const newBalance = userData.gram_balance - totalRequired;
        await supabase
            .from('users')
            .update({ gram_balance: newBalance })
            .eq('id', userId);

        await supabase
            .from('balance_log')
            .insert([{
                id: Date.now(),
                user_id: userId,
                amount: -totalRequired,
                new_balance: newBalance,
                source: 'withdrawal',
                reference_id: `withdraw_${Date.now()}`,
                timestamp: Date.now()
            }]);

        await addWithdrawalTransaction(userId, amount, 'xrocket', 'completed');

        let paymentSuccess = false;
        let txHash = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const paymentResult = await processXrocketTransfer(
                    userId,
                    amount,
                    `WITHDRAW_${userId}_${Date.now()}`
                );
                if (paymentResult.success) {
                    paymentSuccess = true;
                    txHash = paymentResult.txHash;
                    break;
                }
            } catch (error) {
                console.log(`Payment attempt ${attempt} failed:`, error);
                if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
                }
            }
        }

        if (paymentSuccess) {
            await sendNotification(
                userId,
                '✅ Withdrawal Completed',
                `💎 ${amount} GRAM sent via @XRocket!`
            );
            await sendNotification(
                process.env.ADMIN_CHAT_ID || userId,
                '✅ Withdrawal Processed',
                `User ID: ${userId}\nAmount: ${amount} GRAM\nStatus: Completed`
            );
            res.json({
                success: true,
                withdrawn: amount,
                txHash: txHash,
                status: 'completed'
            });
        } else {
            await supabase
                .from('users')
                .update({ gram_balance: newBalance + totalRequired })
                .eq('id', userId);

            await supabase
                .from('balance_log')
                .insert([{
                    id: Date.now(),
                    user_id: userId,
                    amount: totalRequired,
                    new_balance: newBalance + totalRequired,
                    source: 'refund',
                    reference_id: `refund_${Date.now()}`,
                    timestamp: Date.now()
                }]);

            await sendNotification(
                userId,
                '❌ Withdrawal Failed',
                `Failed to send ${amount} GRAM. Balance restored. Please try again.`
            );
            await sendNotification(
                process.env.ADMIN_CHAT_ID || userId,
                '❌ Withdrawal Failed',
                `User ID: ${userId}\nAmount: ${amount} GRAM\nError: Payment failed after 3 attempts`
            );
            res.status(500).json({
                success: false,
                error: 'Payment failed. Balance restored.',
                retry: true
            });
        }
    } catch (error) {
        logError('withdraw/request', error, req);
        res.status(500).json({ error: error.message });
    }
});

async function addWithdrawalTransaction(userId, amount, address, status) {
    try {
        const transaction = {
            id: Date.now(),
            user_id: userId,
            type: 'withdrawal',
            amount: amount,
            currency: 'GRAM',
            address: address || 'xrocket',
            timestamp: Date.now(),
            status: status
        };
        await supabase
            .from('transactions')
            .insert([transaction]);
    } catch (error) {
        console.error('[Withdrawal] Error adding transaction:', error);
    }
}

async function processXrocketTransfer(userId, amount, memo) {
    try {
        const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
        if (!XROCKET_API_KEY) {
            console.warn('XROCKET_API_KEY not set, skipping xRocket transfer');
            return { success: false, error: 'XROCKET_API_KEY missing' };
        }
        const response = await fetch('https://pay.xrocket.exchange/app/transfer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Rocket-Pay-Key': XROCKET_API_KEY
            },
            body: JSON.stringify({
                tgUserId: parseInt(userId),
                currency: 'TONCOIN',
                amount: amount,
                transferId: `GRAM_${userId}_${Date.now()}`,
                description: 'GRAM TOWN Withdrawal'
            })
        });

        const data = await response.json();
        console.log('[xRocket] Transfer Response:', data);

        if (data.success) {
            return { success: true, txHash: data.data.id || data.data.txHash };
        } else {
            return { success: false, error: data.message || 'Transfer failed' };
        }
    } catch (error) {
        console.error('[xRocket] Error:', error);
        return { success: false, error: error.message };
    }
}

app.post('/api/balance/add', async (req, res) => {
    try {
        const { userId, amount, source, referenceId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user' });
        }
        if (!validateNumber(amount, 0.0001)) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        const allowedSources = ['task', 'game', 'referral', 'daily_checkin', 'promo', 'deposit'];
        if (!allowedSources.includes(source)) {
            return res.status(400).json({ error: 'Invalid source' });
        }
        if (referenceId) {
            const { data: existing } = await supabase
                .from('balance_log')
                .select('id')
                .eq('reference_id', referenceId)
                .eq('user_id', userId);
            if (existing && existing.length > 0) {
                return res.status(400).json({ error: 'Already processed' });
            }
        }
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('gram_balance')
            .eq('id', userId)
            .single();
        if (userError || !userData) {
            return res.status(404).json({ error: 'User not found' });
        }
        const newBalance = (userData.gram_balance || 0) + amount;
        const { error: updateError } = await supabase
            .from('users')
            .update({ gram_balance: newBalance })
            .eq('id', userId);
        if (updateError) throw updateError;
        await supabase
            .from('balance_log')
            .insert([{
                id: Date.now(),
                user_id: userId,
                amount: amount,
                new_balance: newBalance,
                source: source,
                reference_id: referenceId || `manual_${Date.now()}`,
                timestamp: Date.now()
            }]);
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('balance/add', error, req);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/balance/batch-add', async (req, res) => {
    try {
        const { userId, rewards } = req.body;
        if (!rewards || rewards.length === 0) {
            return res.status(400).json({ error: 'No rewards' });
        }
        const { data: userData } = await supabase
            .from('users')
            .select('gram_balance')
            .eq('id', userId)
            .single();
        let newBalance = userData.gram_balance || 0;
        const logs = [];
        for (const reward of rewards) {
            newBalance += reward.amount;
            logs.push({
                id: Date.now() + logs.length,
                user_id: userId,
                amount: reward.amount,
                new_balance: newBalance,
                source: reward.source,
                reference_id: reward.referenceId,
                timestamp: Date.now()
            });
        }
        await supabase
            .from('users')
            .update({ gram_balance: newBalance })
            .eq('id', userId);
        await supabase
            .from('balance_log')
            .insert(logs);
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('balance/batch-add', error, req);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/balance/deduct', async (req, res) => {
    try {
        const { userId, amount, source, referenceId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user' });
        }
        if (!validateNumber(amount, 0.0001)) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        const allowedSources = ['withdrawal', 'task_payment'];
        if (!allowedSources.includes(source)) {
            return res.status(400).json({ error: 'Invalid source' });
        }
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('gram_balance')
            .eq('id', userId)
            .single();
        if (userError || !userData) {
            return res.status(404).json({ error: 'User not found' });
        }
        const totalRequired = amount + WITHDRAWAL_FEES;
        if (userData.gram_balance < totalRequired) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        const newBalance = userData.gram_balance - totalRequired;
        const { error: updateError } = await supabase
            .from('users')
            .update({ gram_balance: newBalance })
            .eq('id', userId);
        if (updateError) throw updateError;
        await supabase
            .from('balance_log')
            .insert([{
                id: Date.now(),
                user_id: userId,
                amount: -totalRequired,
                new_balance: newBalance,
                source: source,
                reference_id: referenceId || `deduct_${Date.now()}`,
                timestamp: Date.now()
            }]);
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('balance/deduct', error, req);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/verify', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const admin = await isAdmin(userId);
        res.json({ success: true, isAdmin: admin });
    } catch (error) {
        logError('admin/verify', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const { count: userCount } = await supabase.from('users').select('id', { count: 'exact', head: true });
        const { count: taskCount } = await supabase.from('user_tasks').select('id', { count: 'exact', head: true });
        const { count: txCount } = await supabase.from('transactions').select('id', { count: 'exact', head: true });
        const { count: pendingCount } = await supabase
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq('type', 'withdrawal')
            .eq('status', 'pending');

        res.json({
            success: true,
            data: {
                totalUsers: userCount || 0,
                totalTasks: taskCount || 0,
                totalTransactions: txCount || 0,
                pendingWithdrawals: pendingCount || 0
            }
        });
    } catch (error) {
        logError('admin/stats', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users', adminAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .order('id');
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('admin/users', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/update', adminAuth, async (req, res) => {
    try {
        const { userId, gram_balance, games_balance, state } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const updates = {};
        if (gram_balance !== undefined) updates.gram_balance = gram_balance;
        if (games_balance !== undefined) updates.games_balance = games_balance;
        if (state) updates.state = state;

        const { error } = await supabase
            .from('users')
            .update(updates)
            .eq('id', userId);
        if (error) throw error;

        await logAdminAction(req.adminId, 'update_user', { userId, updates });
        res.json({ success: true });
    } catch (error) {
        logError('admin/users/update', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/delete', adminAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { error } = await supabase
            .from('users')
            .delete()
            .eq('id', userId);
        if (error) throw error;
        await logAdminAction(req.adminId, 'delete_user', { userId });
        res.json({ success: true });
    } catch (error) {
        logError('admin/users/delete', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks', adminAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('user_tasks')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('admin/tasks', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/create', adminAuth, async (req, res) => {
    try {
        const { name, description, url, max_completions } = req.body;
        if (!name || !url) {
            return res.status(400).json({ success: false, error: 'Name and URL required' });
        }
        const taskId = 'task_' + Date.now();
        const taskData = {
            id: taskId,
            name: name,
            description: description || '',
            url: url,
            max_completions: max_completions || 100,
            status: 'active',
            total: 0,
            owner: req.adminId,
            created_at: Date.now()
        };
        const { data, error } = await supabase
            .from('user_tasks')
            .insert([taskData])
            .select();
        if (error) throw error;
        await logAdminAction(req.adminId, 'create_task', { taskId, name });
        res.json({ success: true, data: data[0], message: 'Task created successfully' });
    } catch (error) {
        logError('admin/tasks/create', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/update', adminAuth, async (req, res) => {
    try {
        const { taskId, name, description, url, max_completions } = req.body;
        if (!taskId) {
            return res.status(400).json({ success: false, error: 'Task ID required' });
        }
        const updates = {};
        if (name) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (url) updates.url = url;
        if (max_completions) updates.max_completions = max_completions;

        const { error } = await supabase
            .from('user_tasks')
            .update(updates)
            .eq('id', taskId);
        if (error) throw error;
        await logAdminAction(req.adminId, 'update_task', { taskId, updates });
        res.json({ success: true, message: 'Task updated successfully' });
    } catch (error) {
        logError('admin/tasks/update', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/delete', adminAuth, async (req, res) => {
    try {
        const { taskId } = req.body;
        if (!taskId) {
            return res.status(400).json({ success: false, error: 'Task ID required' });
        }
        const { error } = await supabase
            .from('user_tasks')
            .delete()
            .eq('id', taskId);
        if (error) throw error;
        await logAdminAction(req.adminId, 'delete_task', { taskId });
        res.json({ success: true, message: 'Task deleted successfully' });
    } catch (error) {
        logError('admin/tasks/delete', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/transactions', adminAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('transactions')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(100);
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('admin/transactions', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdraw/approve', adminAuth, async (req, res) => {
    try {
        const { withdrawId } = req.body;
        if (!withdrawId) {
            return res.status(400).json({ success: false, error: 'Withdraw ID required' });
        }
        const { error } = await supabase
            .from('transactions')
            .update({ status: 'completed' })
            .eq('id', withdrawId)
            .eq('type', 'withdrawal');
        if (error) throw error;
        await logAdminAction(req.adminId, 'approve_withdrawal', { withdrawId });
        res.json({ success: true, message: 'Withdrawal approved' });
    } catch (error) {
        logError('admin/withdraw/approve', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdraw/reject', adminAuth, async (req, res) => {
    try {
        const { withdrawId } = req.body;
        if (!withdrawId) {
            return res.status(400).json({ success: false, error: 'Withdraw ID required' });
        }
        const { error } = await supabase
            .from('transactions')
            .update({ status: 'failed' })
            .eq('id', withdrawId)
            .eq('type', 'withdrawal');
        if (error) throw error;
        await logAdminAction(req.adminId, 'reject_withdrawal', { withdrawId });
        res.json({ success: true, message: 'Withdrawal rejected' });
    } catch (error) {
        logError('admin/withdraw/reject', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo', adminAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('promo_codes')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('admin/promo', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/create', adminAuth, async (req, res) => {
    try {
        const { code, reward, type, maxUses } = req.body;
        if (!code) {
            return res.status(400).json({ success: false, error: 'Code required' });
        }
        const promoData = {
            code: code.toUpperCase().trim(),
            reward: reward || 0.001,
            reward_type: type || 'gram',
            max_uses: maxUses || 100,
            total: 0,
            created_at: Date.now()
        };
        const { data, error } = await supabase
            .from('promo_codes')
            .insert([promoData])
            .select();
        if (error) throw error;
        await logAdminAction(req.adminId, 'create_promo', { code });
        res.json({ success: true, data: data[0], message: 'Promo code created' });
    } catch (error) {
        logError('admin/promo/create', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/delete', adminAuth, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ success: false, error: 'Code required' });
        }
        const { error } = await supabase
            .from('promo_codes')
            .delete()
            .eq('code', code);
        if (error) throw error;
        await logAdminAction(req.adminId, 'delete_promo', { code });
        res.json({ success: true, message: 'Promo code deleted' });
    } catch (error) {
        logError('admin/promo/delete', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/notify/all', adminAuth, async (req, res) => {
    try {
        const { title, message, recipients } = req.body;
        if (!title || !message) {
            return res.status(400).json({ success: false, error: 'Title and message required' });
        }

        let query = supabase.from('users').select('id');
        if (recipients === 'active') {
            query = query.eq('state', 'active');
        }
        const { data: users, error } = await query;
        if (error) throw error;

        let sent = 0;
        for (const user of users) {
            try {
                await sendNotification(user.id, title, message);
                sent++;
            } catch (e) {
                console.error('Failed to send to user:', user.id, e);
            }
        }

        await logAdminAction(req.adminId, 'send_notification', { recipients, title, sent });
        res.json({ success: true, sent, message: `Notification sent to ${sent} users` });
    } catch (error) {
        logError('admin/notify/all', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/logs', adminAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admin_logs')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(100);
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        logError('admin/logs', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/time/current', (req, res) => {
    res.json({ serverTime: Date.now() });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'admin.html'));
    }
});

const PORT = process.env.PORT || 8080;

// === KEEP ALIVE FOR RAILWAY ===
setInterval(() => {
    const now = new Date().toISOString();
    console.log(`[Keep-Alive] ${now}`);
}, 10000);

// === PING HEALTH CHECK ===
const http = require('http');
setInterval(() => {
    const req = http.get(`http://localhost:${PORT}/health`, (res) => {
        // console.log('[Health Ping] OK');
    });
    req.on('error', () => {
        // ignore
    });
    req.end();
}, 3000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Health check: /health`);
    console.log(`✅ Admin panel: /`);
    console.log(`✅ Keep-Alive started (every 3s)`);
});
