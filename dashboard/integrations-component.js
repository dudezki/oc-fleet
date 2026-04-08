// ─── Integrations ─────────────────────────────────────────────────────────────
const PORTAL_NAMES = { '4950628': 'MarketingCRM', '21203560': 'OneCRM' };
const ACCESS_LEVELS = ['owner', 'team', 'org', 'admin'];
const ALL_OBJECTS = ['contacts', 'companies', 'deals', 'owners', '2-20106951'];

const Integrations = {
  setup() {
    const { ref, computed, onMounted, reactive } = Vue;
    const groups = ref([]);
    const users = ref([]);
    const loading = ref(true);
    const searchQ = ref('');
    const showOverridesOnly = ref(false);
    const groupModal = reactive({ open: false, isNew: false, name: '', accessLevel: 'owner', canWrite: false, portals: [], objects: ['contacts','companies','deals'], positions: '', saving: false, error: '' });
    const userEdit = reactive({ open: false, row: null, access_level: '', enabled: true, note: '', saving: false, error: '' });
    const bulkModal = reactive({ open: false, group: null, access_level: '', saving: false, result: null, error: '' });

    async function load() {
      loading.value = true;
      const [g, u] = await Promise.all([
        fetch('/api/integrations/groups').then(r=>r.json()).catch(()=>[]),
        fetch('/api/integrations/users').then(r=>r.json()).catch(()=>[])
      ]);
      groups.value = Array.isArray(g) ? g : [];
      users.value = Array.isArray(u) ? u : [];
      loading.value = false;
    }
    onMounted(load);

    const groupCounts = computed(() => {
      const m = {};
      for (const u of users.value) m[u.positionGroup] = (m[u.positionGroup] || 0) + 1;
      return m;
    });

    const filteredUsers = computed(() => {
      const q = searchQ.value.trim().toLowerCase();
      return users.value.filter(u => {
        if (showOverridesOnly.value && !u.isOverride) return false;
        if (q && ![u.name, u.email, u.position, u.positionGroup, u.portal_name].join(' ').toLowerCase().includes(q)) return false;
        return true;
      });
    });

    function openNewGroup() {
      Object.assign(groupModal, { open: true, isNew: true, name: '', accessLevel: 'owner', canWrite: false, portals: [], objects: ['contacts','companies','deals'], positions: '', saving: false, error: '' });
    }
    function openEditGroup(g) {
      Object.assign(groupModal, { open: true, isNew: false, name: g.name, accessLevel: g.accessLevel, canWrite: g.canWrite, portals: [...(g.portals||[])], objects: [...(g.objects||[])], positions: (g.positions||[]).join(', '), saving: false, error: '' });
    }
    async function saveGroup() {
      groupModal.saving = true; groupModal.error = '';
      const body = { accessLevel: groupModal.accessLevel, canWrite: groupModal.canWrite, portals: groupModal.portals, objects: groupModal.objects, positions: groupModal.positions.split(',').map(s=>s.trim()).filter(Boolean) };
      if (groupModal.isNew) body.name = groupModal.name;
      const url = groupModal.isNew ? '/api/integrations/groups' : '/api/integrations/groups/' + encodeURIComponent(groupModal.name);
      const method = groupModal.isNew ? 'POST' : 'PUT';
      const r = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.success) { groupModal.open = false; await load(); }
      else groupModal.error = d.error || 'Failed';
      groupModal.saving = false;
    }
    async function deleteGroup(name) {
      if (!confirm('Delete group "' + name + '"? Existing user rows are unaffected.')) return;
      await fetch('/api/integrations/groups/' + encodeURIComponent(name), { method: 'DELETE' });
      await load();
    }
    function openUserEdit(row) {
      Object.assign(userEdit, { open: true, row, access_level: row.access_level, enabled: row.enabled, note: row.note || '', saving: false, error: '' });
    }
    async function saveUserEdit() {
      userEdit.saving = true; userEdit.error = '';
      const r = await fetch('/api/integrations/users/' + userEdit.row.id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ access_level: userEdit.access_level, enabled: userEdit.enabled, note: userEdit.note }) });
      const d = await r.json();
      if (d.success) { userEdit.open = false; await load(); }
      else userEdit.error = d.error || 'Failed';
      userEdit.saving = false;
    }
    function openBulk(g) {
      Object.assign(bulkModal, { open: true, group: g, access_level: g.accessLevel, saving: false, result: null, error: '' });
    }
    async function saveBulk() {
      bulkModal.saving = true; bulkModal.error = ''; bulkModal.result = null;
      const r = await fetch('/api/integrations/bulk', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ positionGroup: bulkModal.group.name, access_level: bulkModal.access_level }) });
      const d = await r.json();
      if (d.success) { bulkModal.result = d.updated; await load(); }
      else bulkModal.error = d.error || 'Failed';
      bulkModal.saving = false;
    }

    const levelColor = l => ({ org:'text-green-400', admin:'text-purple-400', team:'text-blue-400', owner:'text-gray-400', standard:'text-gray-500' }[l]||'text-gray-500');
    const levelBg   = l => ({ org:'bg-green-900/30 border-green-800', admin:'bg-purple-900/30 border-purple-800', team:'bg-blue-900/30 border-blue-800', owner:'bg-gray-800 border-gray-700', standard:'bg-gray-800 border-gray-700' }[l]||'bg-gray-800 border-gray-700');

    return { groups, users, filteredUsers, loading, searchQ, showOverridesOnly, groupCounts,
             groupModal, userEdit, bulkModal,
             openNewGroup, openEditGroup, saveGroup, deleteGroup,
             openUserEdit, saveUserEdit, openBulk, saveBulk,
             levelColor, levelBg, PORTAL_NAMES, ACCESS_LEVELS, ALL_OBJECTS };
  },
  template: `
  <div class="p-6 space-y-8">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-white">Integrations <span class="text-gray-600 text-sm font-normal">HubSpot access rules</span></h1>
      <button @click="openNewGroup" class="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors">+ New Group</button>
    </div>

    <!-- Layer 1: Position Groups -->
    <div>
      <h2 class="text-sm font-semibold text-gray-400 mb-3">Position Group Rules <span class="text-gray-600 text-xs font-normal">(one edit cascades to all users in the group)</span></h2>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-gray-500 border-b border-gray-800">
              <th class="text-left py-2 pr-4 font-medium">Group</th>
              <th class="text-left py-2 pr-4 font-medium">Portals</th>
              <th class="text-left py-2 pr-4 font-medium">Access Level</th>
              <th class="text-left py-2 pr-4 font-medium">Can Write</th>
              <th class="text-left py-2 pr-4 font-medium">Users</th>
              <th class="text-left py-2 pr-4 font-medium">Positions</th>
              <th class="text-left py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in groups" :key="g.name" class="border-b border-gray-800/50 hover:bg-gray-800/20">
              <td class="py-2.5 pr-4 font-medium text-white">{{ g.name }}</td>
              <td class="py-2.5 pr-4">
                <div class="flex gap-1 flex-wrap">
                  <span v-for="p in g.portals" :key="p" class="px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800 text-[10px]">{{ PORTAL_NAMES[p] || p }}</span>
                  <span v-if="!g.portals.length" class="text-gray-600">All</span>
                </div>
              </td>
              <td class="py-2.5 pr-4"><span :class="[levelBg(g.accessLevel), 'px-2 py-0.5 rounded border text-[10px] font-mono', levelColor(g.accessLevel)]">{{ g.accessLevel }}</span></td>
              <td class="py-2.5 pr-4"><span :class="g.canWrite ? 'text-green-400' : 'text-gray-600'">{{ g.canWrite ? '\u2713 Yes' : '\u2715 No' }}</span></td>
              <td class="py-2.5 pr-4 text-gray-400">{{ groupCounts[g.name] || 0 }}</td>
              <td class="py-2.5 pr-4 text-gray-500 max-w-xs truncate">{{ (g.positions||[]).join(', ') || '\u2014' }}</td>
              <td class="py-2.5">
                <div class="flex gap-1.5">
                  <button @click="openEditGroup(g)" class="text-[10px] px-2 py-0.5 rounded bg-blue-900/40 hover:bg-blue-800/60 text-blue-300 border border-blue-800/50">Edit</button>
                  <button @click="openBulk(g)" class="text-[10px] px-2 py-0.5 rounded bg-yellow-900/40 hover:bg-yellow-800/60 text-yellow-300 border border-yellow-800/50">Bulk Apply</button>
                  <button @click="deleteGroup(g.name)" class="text-[10px] px-2 py-0.5 rounded bg-red-900/40 hover:bg-red-800/60 text-red-400 border border-red-800/50">\u00d7</button>
                </div>
              </td>
            </tr>
            <tr v-if="!groups.length"><td colspan="7" class="py-8 text-center text-gray-600">{{ loading ? 'Loading\u2026' : 'No groups defined' }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Layer 2: User Access -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm font-semibold text-gray-400">User Access <span class="text-gray-600 text-xs font-normal">(per-user exceptions override group defaults)</span></h2>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" v-model="showOverridesOnly" class="accent-blue-500" /> Overrides only
          </label>
          <input v-model="searchQ" placeholder="Search user, email, group\u2026" class="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-1.5 text-xs outline-none focus:border-blue-500 w-48 placeholder-gray-600" />
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-gray-500 border-b border-gray-800">
              <th class="text-left py-2 pr-4 font-medium">User</th>
              <th class="text-left py-2 pr-4 font-medium">Portal</th>
              <th class="text-left py-2 pr-4 font-medium">Group</th>
              <th class="text-left py-2 pr-4 font-medium">Access Level</th>
              <th class="text-left py-2 pr-4 font-medium">Write</th>
              <th class="text-left py-2 pr-4 font-medium">Status</th>
              <th class="text-left py-2 pr-4 font-medium">Note</th>
              <th class="text-left py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in filteredUsers" :key="u.id" class="border-b border-gray-800/50 hover:bg-gray-800/20" :class="u.isOverride ? 'bg-yellow-900/5' : ''">
              <td class="py-2.5 pr-4">
                <div class="text-gray-200 font-medium">{{ u.name }}</div>
                <div class="text-blue-400 text-[11px]">{{ u.email }}</div>
                <div v-if="u.position" class="text-gray-600 text-[10px]">{{ u.position }}</div>
              </td>
              <td class="py-2.5 pr-4"><span class="px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800 text-[10px]">{{ u.portal_name }}</span></td>
              <td class="py-2.5 pr-4">
                <span class="text-gray-300">{{ u.positionGroup }}</span>
                <span v-if="u.isOverride" class="ml-1 text-[9px] text-yellow-400 border border-yellow-700 rounded px-1">override</span>
              </td>
              <td class="py-2.5 pr-4"><span :class="[levelBg(u.access_level), 'px-2 py-0.5 rounded border text-[10px] font-mono', levelColor(u.access_level)]">{{ u.access_level }}</span></td>
              <td class="py-2.5 pr-4"><span :class="['Dev_IT','Finance','Executive'].includes(u.positionGroup) ? 'text-green-400' : 'text-gray-600'">{{ ['Dev_IT','Finance','Executive'].includes(u.positionGroup) ? '\u2713' : '\u2715' }}</span></td>
              <td class="py-2.5 pr-4"><span :class="u.enabled ? 'text-green-400' : 'text-gray-600'">{{ u.enabled ? 'Active' : 'Disabled' }}</span></td>
              <td class="py-2.5 pr-4 text-gray-600 max-w-xs truncate">{{ u.note || '\u2014' }}</td>
              <td class="py-2.5"><button @click="openUserEdit(u)" class="text-[10px] px-2 py-0.5 rounded bg-blue-900/40 hover:bg-blue-800/60 text-blue-300 border border-blue-800/50">Edit</button></td>
            </tr>
            <tr v-if="!filteredUsers.length"><td colspan="8" class="py-8 text-center text-gray-600">{{ loading ? 'Loading\u2026' : 'No users found' }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Group Edit/Create Modal -->
    <div v-if="groupModal.open" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50" @click.self="groupModal.open=false">
      <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-[480px] shadow-2xl space-y-4">
        <h2 class="text-sm font-semibold text-white">{{ groupModal.isNew ? 'New Position Group' : 'Edit: ' + groupModal.name }}</h2>
        <div v-if="groupModal.isNew">
          <label class="text-gray-500 text-xs block mb-1">Group Name</label>
          <input v-model="groupModal.name" placeholder="e.g. CS_TeamLeaders" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 text-xs outline-none focus:border-blue-500" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-gray-500 text-xs block mb-1">Access Level</label>
            <select v-model="groupModal.accessLevel" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 text-xs outline-none focus:border-blue-500">
              <option v-for="l in ACCESS_LEVELS" :key="l" :value="l">{{ l }}</option>
            </select>
          </div>
          <div class="flex items-end pb-2">
            <label class="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" v-model="groupModal.canWrite" class="accent-blue-500" /> Can Write
            </label>
          </div>
        </div>
        <div>
          <label class="text-gray-500 text-xs block mb-1">Portals</label>
          <div class="flex gap-4">
            <label v-for="(pname, pid) in PORTAL_NAMES" :key="pid" class="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" :value="pid" v-model="groupModal.portals" class="accent-blue-500" /> {{ pname }}
            </label>
          </div>
        </div>
        <div>
          <label class="text-gray-500 text-xs block mb-1">Objects</label>
          <div class="flex flex-wrap gap-3">
            <label v-for="obj in ALL_OBJECTS" :key="obj" class="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" :value="obj" v-model="groupModal.objects" class="accent-blue-500" /> {{ obj }}
            </label>
          </div>
        </div>
        <div>
          <label class="text-gray-500 text-xs block mb-1">Positions <span class="text-gray-600">(comma-separated)</span></label>
          <textarea v-model="groupModal.positions" rows="2" placeholder="Quality Assurance Analyst, Senior QA Analyst" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 text-xs outline-none focus:border-blue-500 resize-none" />
        </div>
        <div v-if="groupModal.error" class="text-red-400 text-xs">\u274c {{ groupModal.error }}</div>
        <div class="flex gap-2">
          <button @click="saveGroup" :disabled="groupModal.saving" class="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium">{{ groupModal.saving ? 'Saving\u2026' : 'Save' }}</button>
          <button @click="groupModal.open=false" class="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs">Cancel</button>
        </div>
      </div>
    </div>

    <!-- User Edit Modal -->
    <div v-if="userEdit.open" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50" @click.self="userEdit.open=false">
      <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-96 shadow-2xl space-y-4">
        <h2 class="text-sm font-semibold text-white">Edit Access \u2014 {{ userEdit.row && userEdit.row.name }}</h2>
        <div class="text-gray-500 text-xs">{{ userEdit.row && userEdit.row.email }} \u00b7 {{ userEdit.row && userEdit.row.portal_name }}</div>
        <div>
          <label class="text-gray-500 text-xs block mb-1">Access Level</label>
          <select v-model="userEdit.access_level" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 text-xs outline-none focus:border-blue-500">
            <option v-for="l in ACCESS_LEVELS" :key="l" :value="l">{{ l }}</option>
          </select>
        </div>
        <div>
          <label class="text-gray-500 text-xs block mb-1">Note <span class="text-gray-600">(reason for override)</span></label>
          <input v-model="userEdit.note" placeholder="e.g. Temporary org access for QA campaign" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 text-xs outline-none focus:border-blue-500" />
        </div>
        <label class="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input type="checkbox" v-model="userEdit.enabled" class="accent-blue-500" /> Enabled
        </label>
        <div v-if="userEdit.error" class="text-red-400 text-xs">\u274c {{ userEdit.error }}</div>
        <div class="flex gap-2">
          <button @click="saveUserEdit" :disabled="userEdit.saving" class="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium">{{ userEdit.saving ? 'Saving\u2026' : 'Save Override' }}</button>
          <button @click="userEdit.open=false" class="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Bulk Apply Modal -->
    <div v-if="bulkModal.open" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50" @click.self="bulkModal.open=false">
      <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-96 shadow-2xl space-y-4">
        <h2 class="text-sm font-semibold text-white">\u26a1 Bulk Apply \u2014 {{ bulkModal.group && bulkModal.group.name }}</h2>
        <p class="text-gray-500 text-xs">Updates the group default and applies to all matching users without a manual override.</p>
        <div>
          <label class="text-gray-500 text-xs block mb-1">New Access Level</label>
          <select v-model="bulkModal.access_level" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 text-xs outline-none focus:border-blue-500">
            <option v-for="l in ACCESS_LEVELS" :key="l" :value="l">{{ l }}</option>
          </select>
        </div>
        <div v-if="bulkModal.result !== null" class="text-green-400 text-xs">\u2713 {{ bulkModal.result }} user(s) updated</div>
        <div v-if="bulkModal.error" class="text-red-400 text-xs">\u274c {{ bulkModal.error }}</div>
        <div class="flex gap-2">
          <button @click="saveBulk" :disabled="bulkModal.saving || bulkModal.result !== null" class="flex-1 py-2 rounded-lg bg-yellow-600 hover:bg-yellow-500 disabled:opacity-40 text-white text-xs font-medium">{{ bulkModal.saving ? 'Applying\u2026' : bulkModal.result !== null ? 'Done' : 'Apply to All' }}</button>
          <button @click="bulkModal.open=false" class="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs">Close</button>
        </div>
      </div>
    </div>
  </div>
  `,
};
