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
        'https://snake-production-e4eb.up.railway.app',
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

const MINIMUM_WITHDRAW = 0.01;
const WITHDRAWAL_FEES = 0;
const TON_PRICE_PER_100 = 0.20;

const WITHDRAWAL_LIMITS = {
    maxPerRequest: 0.02,
    cooldownHours: 0,
    pendingThreshold: 0.02
};

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

app.use(async (req, res, next) => {
    const userId = req.body.userId || req.query.userId;
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

app.post('/api/user/get', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        console.log('[User/get] Searching for userId:', userId);
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId);
        if (error) {
            console.error('[User/get] Error:', error.message);
            throw error;
        }
        if (data && data.length > 0) {
            console.log('[User/get] Found user');
            res.json({ success: true, data: data[0] });
        } else {
            console.log('[User/get] User not found');
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
        
        console.log('[User] Creating user:', userData.id, 'referred_by:', userData.referred_by);
        
        const { data, error } = await supabase
            .from('users')
            .insert([userData])
            .select();
        if (error) {
            console.error('[User] Create error:', error.message);
            throw error;
        }
        console.log('[User] Created successfully');
        
        if (userData.referred_by && validateUserId(userData.referred_by)) {
            console.log('[User] Updating referrer total_referrals for:', userData.referred_by);
            
            const { data: referrerData, error: referrerError } = await supabase
                .from('users')
                .select('total_referrals, referral_completed')
                .eq('id', userData.referred_by)
                .single();
            
            if (referrerError) {
                console.error('[User] Error fetching referrer:', referrerError.message);
            }
            
            if (referrerData) {
                const oldTotal = referrerData.total_referrals || 0;
                const newTotal = oldTotal + 1;
                console.log('[User] Referrer old total:', oldTotal, 'new total:', newTotal);
                
                const { error: updateError } = await supabase
                    .from('users')
                    .update({ total_referrals: newTotal })
                    .eq('id', userData.referred_by);
                
                if (updateError) {
                    console.error('[User] Failed to update referrer total_referrals:', updateError.message);
                } else {
                    console.log('[User] ✅ Referrer total_referrals updated to:', newTotal);
                    
                    // Verify the update
                    const { data: verifyData } = await supabase
                        .from('users')
                        .select('total_referrals')
                        .eq('id', userData.referred_by)
                        .single();
                    console.log('[User] Verification - referrer total_referrals now:', verifyData?.total_referrals);
                    
                    await notifyAdmin('referral', `User ${userData.referred_by} got a new referral: ${userData.id}`);
                }
            } else {
                console.log('[User] Referrer not found:', userData.referred_by);
            }
        }
        
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
        console.log('[User] Updating user:', userId);
        const { error } = await supabase
            .from('users')
            .update(data)
            .eq('id', userId);
        if (error) {
            console.error('[User] Update error:', error.message);
            throw error;
        }
        console.log('[User] Updated successfully');
        
        // Verify update if total_referrals was updated
        if (data.total_referrals !== undefined) {
            const { data: verifyData } = await supabase
                .from('users')
                .select('total_referrals')
                .eq('id', userId)
                .single();
            console.log('[User] Verification - total_referrals now:', verifyData?.total_referrals);
        }
        
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

        const { data, error } = await supabase
            .from('user_tasks')
            .insert([taskData])
            .select();

        if (error) throw error;
        
        await notifyAdmin('task', `New task created: ${taskData.name} by user ${taskData.owner}`);
        
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

app.post('/api/tasks/increment', async (req, res) => {
    try {
        const { taskId } = req.body;
        if (!validateString(taskId, 50)) {
            return res.status(400).json({ success: false, error: 'Invalid task ID' });
        }
        const { data: taskData, error: fetchError } = await supabase
            .from('user_tasks')
            .select('total, max_completions')
            .eq('id', taskId)
            .single();
        
        if (fetchError || !taskData) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
        const newTotal = (taskData.total || 0) + 1;
        const isCompleted = newTotal >= taskData.max_completions;
        const status = isCompleted ? 'completed' : 'active';
        
        const { error } = await supabase
            .from('user_tasks')
            .update({ total: newTotal, status: status })
            .eq('id', taskId);
        
        if (error) throw error;
        res.json({ success: true, total: newTotal, completed: isCompleted });
    } catch (error) {
        logError('tasks/increment', error, req);
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

app.post('/api/notify/admin', async (req, res) => {
    try {
        const { type, message } = req.body;
        const adminId = process.env.ADMIN_CHAT_ID;
        if (!adminId) {
            return res.json({ success: false, error: 'Admin not configured' });
        }
        const BOT_TOKEN = process.env.BOT_TOKEN;
        const hashtagMap = {
            'deposit': '#Deposit',
            'withdraw': '#Withdraw',
            'task': '#Task',
            'referral': '#Referral'
        };
        const hashtag = hashtagMap[type] || '#Notification';
        const fullMessage = `${hashtag}\n\n${message}`;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: adminId,
                text: fullMessage,
                parse_mode: 'Markdown'
            })
        });
        res.json({ success: true });
    } catch (error) {
        logError('notify/admin', error, req);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function notifyAdmin(type, message) {
    try {
        const adminId = process.env.ADMIN_CHAT_ID;
        if (!adminId) return;
        const BOT_TOKEN = process.env.BOT_TOKEN;
        const hashtagMap = {
            'deposit': '#Deposit',
            'withdraw': '#Withdraw',
            'task': '#Task',
            'referral': '#Referral'
        };
        const hashtag = hashtagMap[type] || '#Notification';
        const fullMessage = `${hashtag}\n\n${message}`;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: adminId,
                text: fullMessage,
                parse_mode: 'Markdown'
            })
        });
    } catch (error) {
        console.error('Failed to notify admin:', error);
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
        const allowedSources = ['task', 'game', 'referral', 'daily_checkin', 'promo', 'deposit', 'refund'];
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
            .select('gram_balance, referred_by')
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
        
        if (source === 'task' && userData.referred_by) {
            const tasksPercent = 15;
            const referralAmount = amount * (tasksPercent / 100);
            if (referralAmount > 0) {
                console.log('[Referral] Adding task bonus:', referralAmount, 'to referrer:', userData.referred_by);
                const { data: referrerData } = await supabase
                    .from('users')
                    .select('gram_balance, claimable_earnings, total_earnings')
                    .eq('id', userData.referred_by)
                    .single();
                if (referrerData) {
                    const newReferrerBalance = (referrerData.gram_balance || 0) + referralAmount;
                    const claimableGram = (referrerData.claimable_earnings?.gram || 0) + referralAmount;
                    const totalGram = (referrerData.total_earnings?.gram || 0) + referralAmount;
                    await supabase
                        .from('users')
                        .update({
                            gram_balance: newReferrerBalance,
                            claimable_earnings: { gram: claimableGram, games: referrerData.claimable_earnings?.games || 0 },
                            total_earnings: { gram: totalGram, games: referrerData.total_earnings?.games || 0 }
                        })
                        .eq('id', userData.referred_by);
                    console.log('[Referral] Task bonus added successfully');
                }
            }
        }
        
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('balance/add', error, req);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/balance/add-games', async (req, res) => {
    try {
        const { userId, amount, source, referenceId } = req.body;
        if (!validateUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user' });
        }
        if (!validateNumber(amount, 1)) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        const allowedSources = ['task', 'game', 'referral', 'daily_checkin', 'promo', 'ad_watch'];
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
            .select('games_balance, referred_by')
            .eq('id', userId)
            .single();
        if (userError || !userData) {
            return res.status(404).json({ error: 'User not found' });
        }
        const newBalance = (userData.games_balance || 0) + amount;
        const { error: updateError } = await supabase
            .from('users')
            .update({ games_balance: newBalance })
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
                reference_id: referenceId || `games_${Date.now()}`,
                timestamp: Date.now(),
                type: 'games'
            }]);
        
        if (source === 'game' && userData.referred_by) {
            const gamesPercent = 10;
            const referralAmount = amount * (gamesPercent / 100);
            if (referralAmount > 0) {
                console.log('[Referral] Adding games bonus:', referralAmount, 'to referrer:', userData.referred_by);
                const { data: referrerData } = await supabase
                    .from('users')
                    .select('gram_balance, claimable_earnings, total_earnings')
                    .eq('id', userData.referred_by)
                    .single();
                if (referrerData) {
                    const newReferrerBalance = (referrerData.gram_balance || 0) + referralAmount;
                    const claimableGram = (referrerData.claimable_earnings?.gram || 0) + referralAmount;
                    const totalGram = (referrerData.total_earnings?.gram || 0) + referralAmount;
                    await supabase
                        .from('users')
                        .update({
                            gram_balance: newReferrerBalance,
                            claimable_earnings: { gram: claimableGram, games: referrerData.claimable_earnings?.games || 0 },
                            total_earnings: { gram: totalGram, games: referrerData.total_earnings?.games || 0 }
                        })
                        .eq('id', userData.referred_by);
                    console.log('[Referral] Games bonus added successfully');
                }
            }
        }
        
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('balance/add-games', error, req);
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

app.post('/api/referral/check-completion', async (req, res) => {
    try {
        const { userId, referrerId, firstName } = req.body;
        console.log('[Referral] Processing:', { userId, referrerId });
        
        if (!validateUserId(userId) || !validateUserId(referrerId)) {
            console.log('[Referral] Invalid user IDs');
            return res.status(400).json({ error: 'Invalid user IDs' });
        }
        if (userId === referrerId) {
            console.log('[Referral] User cannot refer themselves');
            return res.json({ success: true, rewardAdded: false });
        }
        
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('referral_completed, daily_tasks_completed')
            .eq('id', userId)
            .single();
        
        if (userError) {
            console.log('[Referral] DB error:', userError.message);
        }
        
        if (!userData) {
            console.log('[Referral] User not found:', userId);
            return res.json({ success: true, rewardAdded: false });
        }
        
        console.log('[Referral] User data - referral_completed:', userData.referral_completed, 'daily_tasks_completed:', userData.daily_tasks_completed);
        
        if (userData.referral_completed) {
            console.log('[Referral] Already completed for user:', userId);
            return res.json({ success: true, rewardAdded: false });
        }
        
        if ((userData.daily_tasks_completed || 0) < 1) {
            console.log('[Referral] Tasks not completed:', userData.daily_tasks_completed);
            return res.json({ success: true, rewardAdded: false });
        }
        
        console.log('[Referral] ✅ Adding reward to referrer:', referrerId);
        
        const gamesReward = 3;
        
        const { data: referrerData, error: referrerError } = await supabase
            .from('users')
            .select('games_balance, total_referrals, active_referrals, claimable_earnings, total_earnings')
            .eq('id', referrerId)
            .single();
        
        if (referrerError) {
            console.log('[Referral] Referrer error:', referrerError.message);
        }
        
        if (!referrerData) {
            console.log('[Referral] Referrer not found:', referrerId);
            return res.json({ success: true, rewardAdded: false });
        }
        
        console.log('[Referral] Referrer data - games_balance:', referrerData.games_balance, 'total_referrals:', referrerData.total_referrals);
        
        const newGamesBalance = (referrerData.games_balance || 0) + gamesReward;
        const newTotalReferrals = (referrerData.total_referrals || 0) + 1;
        const newActiveReferrals = (referrerData.active_referrals || 0) + 1;
        const claimableGames = (referrerData.claimable_earnings?.games || 0) + gamesReward;
        const totalGames = (referrerData.total_earnings?.games || 0) + gamesReward;
        
        console.log('[Referral] Updating referrer - new games_balance:', newGamesBalance, 'new total_referrals:', newTotalReferrals);
        
        const { error: updateError } = await supabase
            .from('users')
            .update({
                games_balance: newGamesBalance,
                total_referrals: newTotalReferrals,
                active_referrals: newActiveReferrals,
                claimable_earnings: { gram: referrerData.claimable_earnings?.gram || 0, games: claimableGames },
                total_earnings: { gram: referrerData.total_earnings?.gram || 0, games: totalGames }
            })
            .eq('id', referrerId);
        
        if (updateError) {
            console.log('[Referral] Update error:', updateError.message);
            return res.status(500).json({ error: 'Failed to update referrer' });
        }
        
        // Verify update
        const { data: verifyData } = await supabase
            .from('users')
            .select('games_balance, total_referrals')
            .eq('id', referrerId)
            .single();
        console.log('[Referral] Verification - games_balance:', verifyData?.games_balance, 'total_referrals:', verifyData?.total_referrals);
        
        const { error: completeError } = await supabase
            .from('users')
            .update({ referral_completed: true })
            .eq('id', userId);
        
        if (completeError) {
            console.log('[Referral] Complete error:', completeError.message);
        }
        
        console.log('[Referral] ✅ Reward added successfully');
        
        const userFirstName = firstName || 'User';
        await sendNotification(referrerId, 'New Referral Active!', 
            `🔔 New Referral Active!\n\n🫂 ${userFirstName} is active!\n⚡ You will earn unlimited GRAM!\n-> 15% from tasks earnings\n-> 10% from games earnings\n\n🎮 ${gamesReward} Games has been received!`);
        await notifyAdmin('referral', `Referral bonus: ${gamesReward} Games to user ${referrerId} from referral ${userId} (${userFirstName})`);
        
        res.json({ 
            success: true, 
            rewardAdded: true, 
            newBalance: referrerData.gram_balance, 
            newGamesBalance: newGamesBalance 
        });
    } catch (error) {
        console.error('[Referral] Error:', error);
        logError('referral/check-completion', error, req);
        res.status(500).json({ error: error.message });
    }
});

async function processXrocketTransfer(userId, amount, memo) {
    try {
        if (!process.env.XROCKET_API_KEY) {
            console.warn('[xRocket] API key missing, simulating success');
            return { success: true, txHash: 'simulated_' + Date.now() };
        }
        
        const response = await fetch('https://pay.xrocket.exchange/app/transfer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Rocket-Pay-Key': process.env.XROCKET_API_KEY
            },
            body: JSON.stringify({
                tgUserId: parseInt(userId),
                currency: 'TONCOIN',
                amount: amount,
                transferId: `GRAM_${userId}`,
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

async function sendNotification(userId, title, message) {
    try {
        const BOT_TOKEN = process.env.BOT_TOKEN;
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

app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount } = req.body;
    console.log('[Withdraw] Request:', { userId, amount });
    
    if (!validateUserId(userId)) {
        console.log('[Withdraw] Invalid userId');
        return res.status(400).json({ error: 'Invalid user' });
    }
    if (!validateNumber(amount, 0.0001)) {
        console.log('[Withdraw] Invalid amount');
        return res.status(400).json({ error: 'Invalid amount' });
    }

    try {
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('gram_balance')
            .eq('id', userId)
            .single();

        if (userError || !userData) {
            console.log('[Withdraw] User not found');
            return res.status(404).json({ error: 'User not found' });
        }

        const totalRequired = amount + WITHDRAWAL_FEES;
        if (userData.gram_balance < totalRequired) {
            console.log('[Withdraw] Insufficient balance');
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

        if (amount > WITHDRAWAL_LIMITS.maxPerRequest) {
            await addWithdrawalTransaction(userId, amount, 'xrocket', 'pending');
            await notifyAdmin('withdraw', `User ${userId} requested withdrawal of ${amount} GRAM (PENDING)`);
            await sendNotification(userId, '✅ Withdrawal Requested', `💎 Your withdrawal of ${amount} GRAM has been requested.`);
            return res.json({ success: true, status: 'pending' });
        }

        let paymentSuccess = false;
        let txHash = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const paymentResult = await processXrocketTransfer(userId, amount, `WITHDRAW_${userId}_${Date.now()}`);
                if (paymentResult.success) {
                    paymentSuccess = true;
                    txHash = paymentResult.txHash;
                    break;
                }
            } catch (error) {
                console.log(`[Withdraw] Attempt ${attempt} failed`);
            }
        }

        if (paymentSuccess) {
            await addWithdrawalTransaction(userId, amount, 'xrocket', 'completed');
            await notifyAdmin('withdraw', `User ${userId} withdrew ${amount} GRAM (COMPLETED)`);
            await sendNotification(userId, '✅ Withdrawal Completed', `💎 Your withdrawal of ${amount} GRAM has been sent!`);
            res.json({ success: true, withdrawn: amount, txHash, status: 'completed' });
        } else {
            const refundBalance = newBalance + totalRequired;
            await supabase.from('users').update({ gram_balance: refundBalance }).eq('id', userId);
            await notifyAdmin('withdraw', `User ${userId} withdrawal FAILED for ${amount} GRAM`);
            res.status(500).json({ success: false, error: 'Payment failed. Balance restored.', retry: true });
        }
    } catch (error) {
        console.error('[Withdraw] Error:', error);
        logError('withdraw/request', error, req);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/time/current', (req, res) => {
    res.json({ serverTime: Date.now() });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
