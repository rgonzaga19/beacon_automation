const usersBody = document.getElementById("usersBody");
const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const summary = document.getElementById("summary");
const errorNode = document.getElementById("error");
const previousBtn = document.getElementById("previousBtn");
const nextBtn = document.getElementById("nextBtn");
const pageLabel = document.getElementById("pageLabel");
let page = 1;
let pages = 1;
let loading = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderUsers(users) {
  if (!users.length) {
    usersBody.innerHTML = '<tr><td colspan="6" class="empty">No users match this search.</td></tr>';
    return;
  }
  usersBody.innerHTML = users.map((user) => {
    const name = user.display_name || user.profile_name || "Name not set";
    return `<tr>
      <td class="identity"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(user.email)}</span></td>
      <td><span class="pill ${user.is_active ? "good" : ""}">${user.is_active ? "Active" : "Inactive"}</span></td>
      <td><span class="pill ${user.is_admin ? "admin" : ""}">${user.is_admin ? "Administrator" : "User"}</span></td>
      <td><span class="pill ${user.beacon_connected ? "good" : ""}">${user.beacon_connected ? `Connected · ${escapeHtml(user.beacon_server || "Beacon")}` : "Not connected"}</span></td>
      <td>${escapeHtml(formatDate(user.created_at))}</td>
      <td>${escapeHtml(formatDate(user.updated_at))}</td>
    </tr>`;
  }).join("");
}

async function loadUsers() {
  if (loading) return;
  loading = true;
  errorNode.style.display = "none";
  previousBtn.disabled = true;
  nextBtn.disabled = true;
  summary.textContent = "Loading users…";
  usersBody.innerHTML = '<tr><td colspan="6" class="empty">Loading user directory…</td></tr>';
  try {
    const params = new URLSearchParams({ page: String(page), per_page: "25", q: searchInput.value.trim() });
    const response = await fetch(`${API_BASE}/api/admin/users?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load user accounts.");
    pages = payload.pages || 1;
    renderUsers(payload.users || []);
    summary.textContent = `${payload.total} account${payload.total === 1 ? "" : "s"}`;
    pageLabel.textContent = `Page ${payload.page} of ${pages}`;
    previousBtn.disabled = payload.page <= 1;
    nextBtn.disabled = payload.page >= pages;
  } catch (error) {
    usersBody.innerHTML = '<tr><td colspan="6" class="empty">User directory unavailable.</td></tr>';
    summary.textContent = "Could not load users";
    errorNode.textContent = error.message || String(error);
    errorNode.style.display = "block";
  } finally {
    loading = false;
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  page = 1;
  loadUsers();
});
document.getElementById("refreshBtn").addEventListener("click", loadUsers);
previousBtn.addEventListener("click", () => { if (page > 1) { page -= 1; loadUsers(); } });
nextBtn.addEventListener("click", () => { if (page < pages) { page += 1; loadUsers(); } });
loadUsers();
