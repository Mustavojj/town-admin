const API_URL = 'https://snake-production-e4eb.up.railway.app/api';

class AdminApp {
    constructor() {
        this.tg = null;
        this.tgUser = null;
        this.isAdmin = false;
        this.currentSection = 'dashboard';
        this.users = [];
        this.tasks = [];
        this.transactions = [];
        this.promoCodes = [];
        this.logs = [];
        this.stats = {};

        this.init();
    }

    async init() {
        try {
            if (!window.Telegram?.WebApp) {
                document.getElementById('login-status').innerHTML = 'Please open from Telegram';
                return;
            }

            this.tg = window.Telegram.WebApp;
            this.tgUser = this.tg.initDataUnsafe?.user;

            if (!this.tgUser) {
                document.getElementById('login-status').innerHTML = 'No user data';
                return;
            }

            this.tg.ready();
            this.tg.expand();

            document.getElementById('admin-name').textContent = this.tgUser.first_name || 'Admin';

            // Check if user is admin
            await this.checkAdmin();

            if (this.isAdmin) {
                document.getElementById('login-screen').classList.remove('active');
                document.getElementById('dashboard-screen').classList.add('active');
                await this.loadDashboard();
                this.setupEventListeners();
            } else {
                document.getElementById('login-status').innerHTML = '❌ You are not an admin';
            }

        } catch (error) {
            console.error('Admin init error:', error);
            document.getElementById('login-status').innerHTML = 'Error: ' + error.message;
        }
    }

    async checkAdmin() {
        try {
            const response = await fetch(`${API_URL}/admin/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: this.tgUser.id })
            });
            const result = await response.json();
            this.isAdmin = result.success && result.isAdmin;
            return this.isAdmin;
        } catch (error) {
            console.error('Check admin error:', error);
            return false;
        }
    }

    async apiCall(endpoint, data = {}) {
        try {
            const response = await fetch(`${API_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...data, adminId: this.tgUser.id })
            });
            return await response.json();
        } catch (error) {
            console.error('API call error:', error);
            return { success: false, error: error.message };
        }
    }

    async loadDashboard() {
        try {
            const result = await this.apiCall('/admin/stats');
            if (result.success) {
                this.stats = result.data;
                document.getElementById('total-users').textContent = this.stats.totalUsers || 0;
                document.getElementById('total-tasks').textContent = this.stats.totalTasks || 0;
                document.getElementById('total-transactions').textContent = this.stats.totalTransactions || 0;
                document.getElementById('pending-withdrawals').textContent = this.stats.pendingWithdrawals || 0;
                this.renderRecentActivity();
            }
        } catch (error) {
            console.error('Load dashboard error:', error);
        }
    }

    async loadUsers() {
        try {
            const result = await this.apiCall('/admin/users');
            if (result.success) {
                this.users = result.data;
                this.renderUsers();
            }
        } catch (error) {
            console.error('Load users error:', error);
        }
    }

    async loadTasks() {
        try {
            const result = await this.apiCall('/admin/tasks');
            if (result.success) {
                this.tasks = result.data;
                this.renderTasks();
            }
        } catch (error) {
            console.error('Load tasks error:', error);
        }
    }

    async loadTransactions() {
        try {
            const result = await this.apiCall('/admin/transactions');
            if (result.success) {
                this.transactions = result.data;
                this.renderTransactions();
            }
        } catch (error) {
            console.error('Load transactions error:', error);
        }
    }

    async loadPromoCodes() {
        try {
            const result = await this.apiCall('/admin/promo');
            if (result.success) {
                this.promoCodes = result.data;
                this.renderPromoCodes();
            }
        } catch (error) {
            console.error('Load promo codes error:', error);
        }
    }

    async loadLogs() {
        try {
            const result = await this.apiCall('/admin/logs');
            if (result.success) {
                this.logs = result.data;
                this.renderLogs();
            }
        } catch (error) {
            console.error('Load logs error:', error);
        }
    }

    renderRecentActivity() {
        const container = document.getElementById('recent-activity-list');
        const activities = this.logs.slice(0, 10);
        if (activities.length === 0) {
            container.innerHTML = '<div class="no-data">No recent activity</div>';
            return;
        }
        container.innerHTML = activities.map(log => `
            <div class="activity-item">
                <span>${log.action}</span>
                <span class="activity-time">${new Date(log.timestamp).toLocaleString()}</span>
            </div>
        `).join('');
    }

    renderUsers() {
        const container = document.getElementById('users-table-container');
        if (this.users.length === 0) {
            container.innerHTML = '<div class="no-data">No users found</div>';
            return;
        }
        const search = document.getElementById('user-search')?.value?.toLowerCase() || '';
        const filtered = this.users.filter(u => 
            u.id.toString().includes(search) || 
            (u.username || '').toLowerCase().includes(search)
        );
        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Username</th>
                        <th>GRAM</th>
                        <th>Games</th>
                        <th>Referrals</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${filtered.map(user => `
                        <tr>
                            <td>${user.id}</td>
                            <td>${user.username || 'N/A'}</td>
                            <td>${(user.gram_balance || 0).toFixed(4)}</td>
                            <td>${user.games_balance || 0}</td>
                            <td>${user.total_referrals || 0}</td>
                            <td><span class="badge badge-${user.state === 'banned' ? 'banned' : 'active'}">${user.state || 'active'}</span></td>
                            <td>
                                <button class="action-btn edit" onclick="window.admin.editUser('${user.id}')"><i class="fas fa-edit"></i></button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    renderTasks() {
        const container = document.getElementById('tasks-table-container');
        if (this.tasks.length === 0) {
            container.innerHTML = '<div class="no-data">No tasks found</div>';
            return;
        }
        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Name</th>
                        <th>URL</th>
                        <th>Max</th>
                        <th>Total</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.tasks.map(task => `
                        <tr>
                            <td>${task.id}</td>
                            <td>${task.name}</td>
                            <td><a href="${task.url}" target="_blank">Link</a></td>
                            <td>${task.max_completions}</td>
                            <td>${task.total || 0}</td>
                            <td><span class="badge badge-${task.status}">${task.status}</span></td>
                            <td>
                                <button class="action-btn edit" onclick="window.admin.editTask('${task.id}')"><i class="fas fa-edit"></i></button>
                                <button class="action-btn delete" onclick="window.admin.deleteTask('${task.id}')"><i class="fas fa-trash"></i></button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    renderTransactions() {
        const container = document.getElementById('transactions-table-container');
        const filter = document.getElementById('tx-filter')?.value || 'all';
        const filtered = this.transactions.filter(tx => {
            if (filter === 'all') return true;
            if (filter === 'pending') return tx.status === 'pending';
            return tx.type === filter;
        });
        if (filtered.length === 0) {
            container.innerHTML = '<div class="no-data">No transactions found</div>';
            return;
        }
        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>User</th>
                        <th>Type</th>
                        <th>Amount</th>
                        <th>Status</th>
                        <th>Time</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${filtered.map(tx => `
                        <tr>
                            <td>${tx.id}</td>
                            <td>${tx.user_id}</td>
                            <td>${tx.type}</td>
                            <td>${(tx.amount || 0).toFixed(4)} GRAM</td>
                            <td><span class="badge badge-${tx.status}">${tx.status}</span></td>
                            <td>${new Date(tx.timestamp).toLocaleString()}</td>
                            <td>
                                ${tx.status === 'pending' ? `<button class="action-btn approve" onclick="window.admin.approveWithdraw('${tx.id}')"><i class="fas fa-check"></i></button>` : ''}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    renderPromoCodes() {
        const container = document.getElementById('promo-table-container');
        if (this.promoCodes.length === 0) {
            container.innerHTML = '<div class="no-data">No promo codes found</div>';
            return;
        }
        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Code</th>
                        <th>Reward</th>
                        <th>Type</th>
                        <th>Used</th>
                        <th>Max Uses</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.promoCodes.map(code => `
                        <tr>
                            <td><strong>${code.code}</strong></td>
                            <td>${code.reward}</td>
                            <td>${code.reward_type}</td>
                            <td>${code.total || 0}</td>
                            <td>${code.max_uses || '∞'}</td>
                            <td>
                                <button class="action-btn delete" onclick="window.admin.deletePromo('${code.code}')"><i class="fas fa-trash"></i></button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    renderLogs() {
        const container = document.getElementById('logs-table-container');
        if (this.logs.length === 0) {
            container.innerHTML = '<div class="no-data">No logs found</div>';
            return;
        }
        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Admin</th>
                        <th>Action</th>
                        <th>Details</th>
                        <th>Time</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.logs.map(log => `
                        <tr>
                            <td>${log.admin_id}</td>
                            <td>${log.action}</td>
                            <td>${JSON.stringify(log.details)}</td>
                            <td>${new Date(log.timestamp).toLocaleString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    setupEventListeners() {
        // Sidebar navigation
        document.querySelectorAll('.sidebar-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.switchSection(btn.dataset.section);
            });
        });

        // Logout
        document.getElementById('logout-btn')?.addEventListener('click', () => {
            localStorage.removeItem('admin_session');
            document.getElementById('dashboard-screen').classList.remove('active');
            document.getElementById('login-screen').classList.add('active');
        });

        // Login
        document.getElementById('login-btn')?.addEventListener('click', async () => {
            await this.init();
        });

        // User search
        document.getElementById('user-search')?.addEventListener('input', () => {
            this.renderUsers();
        });

        // Transaction filter
        document.getElementById('tx-filter')?.addEventListener('change', () => {
            this.renderTransactions();
        });

        // Add task
        document.getElementById('add-task-btn')?.addEventListener('click', () => {
            this.openTaskModal();
        });

        // Save task
        document.getElementById('save-task-btn')?.addEventListener('click', async () => {
            await this.saveTask();
        });

        // Add promo
        document.getElementById('add-promo-btn')?.addEventListener('click', () => {
            this.openPromoModal();
        });

        // Save promo
        document.getElementById('save-promo-btn')?.addEventListener('click', async () => {
            await this.savePromo();
        });

        // Send notification
        document.getElementById('send-notif-btn')?.addEventListener('click', async () => {
            await this.sendNotification();
        });

        // Modal close buttons
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const modalId = btn.dataset.modal;
                document.getElementById(modalId).style.display = 'none';
            });
        });

        // Close modals on outside click
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.style.display = 'none';
                }
            });
        });

        // Save user
        document.getElementById('save-user-btn')?.addEventListener('click', async () => {
            await this.saveUser();
        });

        // Delete user
        document.getElementById('delete-user-btn')?.addEventListener('click', async () => {
            await this.deleteUser();
        });

        // Approve withdrawal
        document.getElementById('approve-withdraw-btn')?.addEventListener('click', async () => {
            await this.approveWithdrawal();
        });

        // Reject withdrawal
        document.getElementById('reject-withdraw-btn')?.addEventListener('click', async () => {
            await this.rejectWithdrawal();
        });
    }

    switchSection(section) {
        this.currentSection = section;
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        document.getElementById(`section-${section}`).classList.add('active');

        switch (section) {
            case 'dashboard':
                this.loadDashboard();
                break;
            case 'users':
                this.loadUsers();
                break;
            case 'tasks':
                this.loadTasks();
                break;
            case 'transactions':
                this.loadTransactions();
                break;
            case 'promo':
                this.loadPromoCodes();
                break;
            case 'notifications':
                break;
            case 'logs':
                this.loadLogs();
                break;
        }
    }

    openTaskModal(task = null) {
        const modal = document.getElementById('task-modal');
        const title = document.getElementById('task-modal-title');
        title.textContent = task ? 'Edit Task' : 'Add Task';
        
        document.getElementById('task-edit-id').value = task?.id || '';
        document.getElementById('task-name').value = task?.name || '';
        document.getElementById('task-desc').value = task?.description || '';
        document.getElementById('task-url').value = task?.url || '';
        document.getElementById('task-max').value = task?.max_completions || 100;
        document.getElementById('task-gram').value = task?.reward_gram || 0.0001;
        document.getElementById('task-games').value = task?.reward_games || 1;
        
        modal.style.display = 'flex';
    }

    async saveTask() {
        const id = document.getElementById('task-edit-id').value;
        const name = document.getElementById('task-name').value;
        const description = document.getElementById('task-desc').value;
        const url = document.getElementById('task-url').value;
        const maxCompletions = parseInt(document.getElementById('task-max').value) || 100;
        const rewardGram = parseFloat(document.getElementById('task-gram').value) || 0.0001;
        const rewardGames = parseInt(document.getElementById('task-games').value) || 1;

        if (!name || !url) {
            alert('Name and URL are required');
            return;
        }

        const data = { name, description, url, max_completions: maxCompletions, reward_gram: rewardGram, reward_games: rewardGames };
        
        let result;
        if (id) {
            result = await this.apiCall('/admin/tasks/update', { taskId: id, ...data });
        } else {
            result = await this.apiCall('/admin/tasks/create', data);
        }

        if (result.success) {
            document.getElementById('task-modal').style.display = 'none';
            this.loadTasks();
            alert(result.message || 'Task saved successfully');
        } else {
            alert('Error: ' + result.error);
        }
    }

    async deleteTask(taskId) {
        if (!confirm('Are you sure you want to delete this task?')) return;
        const result = await this.apiCall('/admin/tasks/delete', { taskId });
        if (result.success) {
            this.loadTasks();
            alert('Task deleted successfully');
        } else {
            alert('Error: ' + result.error);
        }
    }

    editTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (task) this.openTaskModal(task);
    }

    openPromoModal() {
        document.getElementById('promo-modal').style.display = 'flex';
        document.getElementById('promo-code').value = '';
        document.getElementById('promo-reward').value = '0.001';
        document.getElementById('promo-max').value = '100';
    }

    async savePromo() {
        const code = document.getElementById('promo-code').value.trim();
        const reward = parseFloat(document.getElementById('promo-reward').value) || 0.001;
        const type = document.getElementById('promo-type').value;
        const maxUses = parseInt(document.getElementById('promo-max').value) || 100;

        if (!code) {
            alert('Code is required');
            return;
        }

        const result = await this.apiCall('/admin/promo/create', { code, reward, type, maxUses });
        if (result.success) {
            document.getElementById('promo-modal').style.display = 'none';
            this.loadPromoCodes();
            alert('Promo code created successfully');
        } else {
            alert('Error: ' + result.error);
        }
    }

    async deletePromo(code) {
        if (!confirm(`Delete promo code "${code}"?`)) return;
        const result = await this.apiCall('/admin/promo/delete', { code });
        if (result.success) {
            this.loadPromoCodes();
            alert('Promo code deleted');
        } else {
            alert('Error: ' + result.error);
        }
    }

    editUser(userId) {
        const user = this.users.find(u => u.id.toString() === userId.toString());
        if (!user) return;
        document.getElementById('user-modal').style.display = 'flex';
        document.getElementById('user-edit-id').value = user.id;
        document.getElementById('user-id-display').value = user.id;
        document.getElementById('user-username').value = user.username || 'N/A';
        document.getElementById('user-gram').value = user.gram_balance || 0;
        document.getElementById('user-games').value = user.games_balance || 0;
        document.getElementById('user-status').value = user.state || 'active';
    }

    async saveUser() {
        const userId = document.getElementById('user-edit-id').value;
        const gram = parseFloat(document.getElementById('user-gram').value) || 0;
        const games = parseInt(document.getElementById('user-games').value) || 0;
        const status = document.getElementById('user-status').value;

        const result = await this.apiCall('/admin/users/update', {
            userId: parseInt(userId),
            gram_balance: gram,
            games_balance: games,
            state: status
        });

        if (result.success) {
            document.getElementById('user-modal').style.display = 'none';
            this.loadUsers();
            alert('User updated successfully');
        } else {
            alert('Error: ' + result.error);
        }
    }

    async deleteUser() {
        const userId = document.getElementById('user-edit-id').value;
        if (!confirm(`Are you sure you want to delete user ${userId}? This action cannot be undone.`)) return;
        
        const result = await this.apiCall('/admin/users/delete', { userId: parseInt(userId) });
        if (result.success) {
            document.getElementById('user-modal').style.display = 'none';
            this.loadUsers();
            alert('User deleted successfully');
        } else {
            alert('Error: ' + result.error);
        }
    }

    async approveWithdraw(withdrawId) {
        const transaction = this.transactions.find(t => t.id === withdrawId);
        if (!transaction) return;
        
        document.getElementById('withdraw-modal').style.display = 'flex';
        document.getElementById('withdraw-id').value = withdrawId;
        document.getElementById('withdraw-user-id').textContent = transaction.user_id;
        document.getElementById('withdraw-amount').textContent = (transaction.amount || 0).toFixed(4);
        document.getElementById('withdraw-address').textContent = transaction.address || 'N/A';
    }

    async approveWithdrawal() {
        const id = document.getElementById('withdraw-id').value;
        const result = await this.apiCall('/admin/withdraw/approve', { withdrawId: id });
        if (result.success) {
            document.getElementById('withdraw-modal').style.display = 'none';
            this.loadTransactions();
            alert('Withdrawal approved successfully');
        } else {
            alert('Error: ' + result.error);
        }
    }

    async rejectWithdrawal() {
        const id = document.getElementById('withdraw-id').value;
        if (!confirm('Reject this withdrawal request?')) return;
        const result = await this.apiCall('/admin/withdraw/reject', { withdrawId: id });
        if (result.success) {
            document.getElementById('withdraw-modal').style.display = 'none';
            this.loadTransactions();
            alert('Withdrawal rejected');
        } else {
            alert('Error: ' + result.error);
        }
    }

    async sendNotification() {
        const title = document.getElementById('notif-title').value.trim();
        const message = document.getElementById('notif-message').value.trim();
        const recipients = document.getElementById('notif-recipients').value;
        const statusEl = document.getElementById('notif-status');

        if (!title || !message) {
            statusEl.className = 'notif-status error';
            statusEl.textContent = 'Title and message are required';
            return;
        }

        statusEl.className = 'notif-status info';
        statusEl.textContent = 'Sending...';

        const result = await this.apiCall('/admin/notify/all', { title, message, recipients });
        
        if (result.success) {
            statusEl.className = 'notif-status success';
            statusEl.textContent = `✅ Notification sent to ${result.sent || 0} users`;
            document.getElementById('notif-title').value = '';
            document.getElementById('notif-message').value = '';
        } else {
            statusEl.className = 'notif-status error';
            statusEl.textContent = 'Error: ' + result.error;
        }
    }
}

// Initialize admin
document.addEventListener('DOMContentLoaded', () => {
    window.admin = new AdminApp();
});
