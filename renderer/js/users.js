const usersBody = document.getElementById("usersBody");
const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const summary = document.getElementById("summary");
const errorNode = document.getElementById("error");
const previousBtn = document.getElementById("previousBtn");
const nextBtn = document.getElementById("nextBtn");
const pageLabel = document.getElementById("pageLabel");
const deleteDialog = document.getElementById("deleteDialog");
const deleteEmailInput = document.getElementById("deleteEmailInput");
const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
const deleteTargetEmail = document.getElementById("deleteTargetEmail");
let page = 1;
let pages = 1;
let loading = false;
let pendingDeleteUser = null;

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
    usersBody.innerHTML = '<tr><td colspan="8" class="empty">No users match this search.</td></tr>';
    return;
  }
  usersBody.innerHTML = users.map((user) => {
    const name = user.display_name || user.profile_name || "Name not set";
    const upgradeRequest = user.upgrade_request;
    const requestCell = !upgradeRequest
      ? '<span class="pill">—</span>'
      : `<span class="pill ${upgradeRequest.status === "pending" ? "" : "good"}">${escapeHtml(upgradeRequest.status)}</span>${upgradeRequest.status === "pending" ? `<p>${escapeHtml(upgradeRequest.message)}</p><div class="request-actions"><button class="accept-request-btn" type="button" data-request-id="${upgradeRequest.id}">Accept</button><button class="decline-request-btn" type="button" data-request-id="${upgradeRequest.id}">Decline</button></div>` : ""}`;
    return `<tr>
      <td class="identity"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(user.email)}</span></td>
      <td><span class="pill ${user.is_active ? "good" : ""}">${user.is_active ? "Active" : "Inactive"}</span></td>
      <td><select class="role-select" data-user-id="${user.id}" aria-label="Role for ${escapeHtml(user.email)}" ${user.can_change_role ? "" : "disabled"}>
        <option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option>
        <option value="subscriber" ${user.role === "subscriber" ? "selected" : ""}>Subscriber</option>
        <option value="member" ${user.role === "member" ? "selected" : ""}>Member</option>
      </select></td>
      <td><span class="pill ${user.beacon_connected ? "good" : ""}">${user.beacon_connected ? `Connected · ${escapeHtml(user.beacon_server || "Beacon")}` : "Not connected"}</span></td>
      <td>${escapeHtml(formatDate(user.created_at))}</td>
      <td>${escapeHtml(formatDate(user.updated_at))}</td>
      <td class="upgrade-request-cell">${requestCell}</td>
      <td class="actions-cell"><button class="delete-user-btn" type="button" data-user-id="${user.id}" data-user-email="${escapeHtml(user.email)}" ${user.can_delete ? "" : "disabled"} title="${user.can_delete ? "Delete this account" : "You cannot delete your own account or the last active administrator."}">Delete</button></td>
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
  usersBody.innerHTML = '<tr><td colspan="8" class="empty">Loading user directory…</td></tr>';
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
    usersBody.innerHTML = '<tr><td colspan="8" class="empty">User directory unavailable.</td></tr>';
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
usersBody.addEventListener("click", (event) => {
  const reviewButton = event.target.closest(".accept-request-btn, .decline-request-btn");
  if (reviewButton) {
    reviewUpgradeRequest(reviewButton);
    return;
  }
  const button = event.target.closest(".delete-user-btn");
  if (!button || button.disabled) return;
  pendingDeleteUser = { id: button.dataset.userId, email: button.dataset.userEmail };
  deleteTargetEmail.textContent = pendingDeleteUser.email;
  deleteEmailInput.value = "";
  confirmDeleteBtn.disabled = true;
  deleteDialog.showModal();
  deleteEmailInput.focus();
});

async function reviewUpgradeRequest(button) {
  const decision = button.classList.contains("accept-request-btn") ? "accepted" : "declined";
  const action = decision === "accepted" ? "accept" : "decline";
  if (!window.confirm(`Are you sure you want to ${action} this access request?`)) return;
  button.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/admin/upgrade-requests/${encodeURIComponent(button.dataset.requestId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Could not ${action} this request.`);
    await loadUsers();
    summary.textContent = `Upgrade request ${decision}.`;
  } catch (error) {
    await loadUsers();
    errorNode.textContent = error.message || String(error);
    errorNode.style.display = "block";
  }
}
deleteEmailInput.addEventListener("input", () => {
  confirmDeleteBtn.disabled = !pendingDeleteUser
    || deleteEmailInput.value.trim().toLowerCase() !== pendingDeleteUser.email.toLowerCase();
});
document.getElementById("cancelDeleteBtn").addEventListener("click", () => {
  deleteDialog.close();
  pendingDeleteUser = null;
});
document.getElementById("deleteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingDeleteUser || confirmDeleteBtn.disabled) return;
  confirmDeleteBtn.disabled = true;
  confirmDeleteBtn.textContent = "Deleting…";
  try {
    const response = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(pendingDeleteUser.id)}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not delete this account.");
    deleteDialog.close();
    pendingDeleteUser = null;
    page = 1;
    await loadUsers();
    summary.textContent = "User account deleted.";
  } catch (error) {
    deleteDialog.close();
    pendingDeleteUser = null;
    await loadUsers();
    errorNode.textContent = error.message || String(error);
    errorNode.style.display = "block";
  } finally {
    confirmDeleteBtn.textContent = "Delete account";
  }
});
usersBody.addEventListener("change", async (event) => {
  const select = event.target.closest(".role-select");
  if (!select) return;
  const role = select.value;
  const confirmed = window.confirm(
    role === "admin"
      ? "Promote this account to Admin? Admins can manage other user roles."
      : `Change this account role to ${role === "subscriber" ? "Subscriber" : "Member"}?`
  );
  if (!confirmed) {
    loadUsers();
    return;
  }
  select.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(select.dataset.userId)}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not update this user's role.");
    await loadUsers();
    summary.textContent = `Role updated to ${role}.`;
  } catch (error) {
    await loadUsers();
    errorNode.textContent = error.message || String(error);
    errorNode.style.display = "block";
  }
});
previousBtn.addEventListener("click", () => { if (page > 1) { page -= 1; loadUsers(); } });
nextBtn.addEventListener("click", () => { if (page < pages) { page += 1; loadUsers(); } });
loadUsers();
