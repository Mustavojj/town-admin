const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// Health check endpoint (مهم جداً لـ Railway)
app.get('/', (req, res) => {
    res.send('Admin Panel is running!');
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

// مسار بسيط للاختبار
app.get('/api/test', (req, res) => {
    res.json({ success: true, message: 'API is working!' });
});

// يجب أن يكون هذا في النهاية
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'admin.html'));
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Health check: /health`);
    console.log(`✅ Admin panel: /`);
});
